-- ===========================================================================
-- Tree integrity, snapshot immutability and timestamp maintenance.
--
-- This migration carries the integrity rules that the TypeScript schema cannot
-- express and that application validation alone cannot guarantee. Each trigger
-- below exists because a constraint must hold even when the application is
-- buggy, a migration script is run by hand, or an admin tool writes directly
-- to the tables. A CHECK constraint cannot express any of them, because every
-- one of them either walks related rows or compares a row against its own
-- prior state:
--
--  * **C2 / A3 — cycles and invalid ancestry.** "No category may be its own
--    ancestor" and "no button may be its own ancestor" are statements about an
--    unbounded chain of rows, not about one row. A CHECK cannot reference
--    other rows at all. Without the trigger, a single bad re-parent (or two
--    interleaved ones) writes a cycle that every subsequent recursive query
--    loops on forever.
--  * **A2 — same-product containment.** A child button may only point at a
--    parent in the same product. Checking that requires reading the parent
--    chain's `product_id`; a CHECK cannot. Without it, a buggy write builds a
--    branch that `b:`/`m:` navigation and cascade deletes resolve
--    inconsistently.
--  * **A4 — only `OPEN_SUBMENU` may have children.** Inserting a child under
--    a terminal button, or changing a button's type away from `OPEN_SUBMENU`
--    while it has children, creates rows the customer can never reach. The
--    insert side needs the parent row; the update side needs the child rows —
--    neither is visible to a CHECK.
--  * **Write-once inquiry context.** `product_snapshot` / `selected_options`
--    must survive any later catalog re-pricing or restructuring. Enforcing
--    immutability in the database means no code path — no bulk edit, no
--    migration, no admin script — can rewrite a conversation's history.
--  * **`updated_at` maintenance.** The ORM does not recompute it on `UPDATE`;
--    a single shared trigger keeps every table's row stamp honest so the
--    dashboard never shows a stale "last modified".
--
-- Everything here is idempotent (`CREATE OR REPLACE FUNCTION`,
-- `DROP TRIGGER IF EXISTS`), so re-applying this file cannot duplicate or
-- error on existing objects.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- `updated_at` maintenance — one shared function, attached to every table that
-- carries the column.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
  tables_with_updated_at text[] := ARRAY[
    'bot_setting',
    'category',
    'category_translation',
    'customer',
    'inquiry',
    'message_template',
    'message_translation',
    'product',
    'product_action',
    'product_action_translation',
    'product_translation'
  ];
BEGIN
  FOREACH t IN ARRAY tables_with_updated_at LOOP
    EXECUTE format(
      $f$
        DROP TRIGGER IF EXISTS %1$I_touch_updated_at ON %1$I;
        CREATE TRIGGER %1$I_touch_updated_at
          BEFORE UPDATE ON %1$I
          FOR EACH ROW
          EXECUTE FUNCTION touch_updated_at();
      $f$,
      t
    );
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- C2 — category ancestry: no self-parent, no cycle, no deleted or missing
-- ancestor. Walks the new parent's ancestor chain, bounded as a safety net
-- against pathological data. The bound is a resource guard for the trigger's
-- own walk, not a product depth limit — the schema imposes no depth cap
-- (DATA_MODEL.md §11.3).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION category_check_ancestry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ancestor_id uuid;
  next_id uuid;
  ancestor_deleted_at timestamptz;
  hop integer := 0;
  max_hops constant integer := 64;
BEGIN
  -- Nothing to validate for a root node.
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Skip the walk when an UPDATE leaves the parent untouched, so toggling
  -- `is_active` or soft-deleting does not pay for ancestry work.
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN
    RETURN NEW;
  END IF;

  -- Self-parent is also blocked by a CHECK constraint; the trigger exists to
  -- give the dashboard a named, actionable error.
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION
      'A category cannot be its own parent.'
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Choose a different parent category or leave it as a root.';
  END IF;

  next_id := NEW.parent_id;

  WHILE next_id IS NOT NULL AND hop < max_hops LOOP
    hop := hop + 1;
    ancestor_id := next_id;

    -- Reaching the node being written means the new parent is one of its own
    -- descendants: a cycle.
    IF ancestor_id = NEW.id THEN
      RAISE EXCEPTION
        'Category % cannot be nested inside one of its own descendants.',
        NEW.id
        USING ERRCODE = 'foreign_key_violation',
              HINT = 'Move the descendants first, or choose a parent outside this branch.';
    END IF;

    SELECT c.parent_id, c.deleted_at
      INTO next_id, ancestor_deleted_at
      FROM category c
      WHERE c.id = ancestor_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Category % references an unknown parent category.',
        NEW.id
        USING ERRCODE = 'foreign_key_violation',
              HINT = 'The parent category must exist.';
    END IF;

    -- A chain routed through a tombstone would be invisible to the read path,
    -- which filters deleted rows.
    IF ancestor_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION
        'Category % cannot be nested under the deleted category %.',
        NEW.id, ancestor_id
        USING ERRCODE = 'foreign_key_violation',
              HINT = 'Restore or re-parent the deleted category first.';
    END IF;
  END LOOP;

  IF hop >= max_hops THEN
    RAISE EXCEPTION
      'Category % ancestry walk exceeded the % hop safety bound.',
      NEW.id, max_hops
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'The category tree is too deep to validate; inspect it for corruption.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS category_check_ancestry ON category;
CREATE TRIGGER category_check_ancestry
  BEFORE INSERT OR UPDATE OF parent_id ON category
  FOR EACH ROW
  EXECUTE FUNCTION category_check_ancestry();

-- ---------------------------------------------------------------------------
-- A2 + A3 + A4(insert) — product_action ancestry. One walk enforces:
--   * `product_id` immutability (A2's stability guarantee),
--   * no self-parent and no cycle (A3),
--   * same-product containment along the whole parent chain (A2),
--   * an immediate parent that is menu-capable (A4, insert side).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION product_action_check_ancestry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ancestor_id uuid;
  next_id uuid;
  ancestor_product_id uuid;
  ancestor_type action_type;
  hop integer := 0;
  max_hops constant integer := 64;
BEGIN
  -- A2 stability: a button belongs to exactly one product for its whole life.
  -- Moving a button between products is delete + create, which the UI presents
  -- as a new row — so no update path, and no buggy tool, can ever build a
  -- cross-product branch.
  IF TG_OP = 'UPDATE' AND NEW.product_id <> OLD.product_id THEN
    RAISE EXCEPTION
      'Button % cannot move from product % to product %.',
      NEW.id, OLD.product_id, NEW.product_id
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Delete the button and create it under the new product instead.';
  END IF;

  -- Nothing tree-relevant to validate for a root button.
  IF NEW.parent_action_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Skip the walk when an UPDATE leaves the parent untouched.
  IF TG_OP = 'UPDATE' AND NEW.parent_action_id IS NOT DISTINCT FROM OLD.parent_action_id THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_action_id = NEW.id THEN
    RAISE EXCEPTION
      'A button cannot be its own parent.'
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Choose a different parent menu or make it a root button.';
  END IF;

  next_id := NEW.parent_action_id;

  WHILE next_id IS NOT NULL AND hop < max_hops LOOP
    hop := hop + 1;
    ancestor_id := next_id;

    IF ancestor_id = NEW.id THEN
      RAISE EXCEPTION
        'Button % cannot be nested inside one of its own descendants.',
        NEW.id
        USING ERRCODE = 'foreign_key_violation',
              HINT = 'Move the descendant buttons first, or choose a parent outside this branch.';
    END IF;

    SELECT a.parent_action_id, a.product_id, a.action_type
      INTO next_id, ancestor_product_id, ancestor_type
      FROM product_action a
      WHERE a.id = ancestor_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Button % references an unknown parent button.',
        NEW.id
        USING ERRCODE = 'foreign_key_violation',
              HINT = 'The parent button must exist.';
    END IF;

    -- A2: every ancestor must belong to this button's product.
    IF ancestor_product_id <> NEW.product_id THEN
      RAISE EXCEPTION
        'Button % belongs to product % and cannot sit under a button of product %.',
        NEW.id, NEW.product_id, ancestor_product_id
        USING ERRCODE = 'foreign_key_violation',
              HINT = 'A button tree is owned by one product; create a new button under the other product.';
    END IF;

    -- A4 (insert side): the immediate parent must be able to hold children.
    -- Enforced here rather than by a CHECK because it needs the parent row.
    IF hop = 1 AND ancestor_type <> 'OPEN_SUBMENU' THEN
      RAISE EXCEPTION
        'Button % has the terminal type % and cannot contain child buttons.',
        NEW.id, ancestor_type
        USING ERRCODE = 'foreign_key_violation',
              HINT = 'Only an OPEN_SUBMENU button can have children.';
    END IF;
  END LOOP;

  IF hop >= max_hops THEN
    RAISE EXCEPTION
      'Button % ancestry walk exceeded the % hop safety bound.',
      NEW.id, max_hops
      USING ERRCODE = 'foreign_key_violation',
              HINT = 'The button tree is too deep to validate; inspect it for corruption.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_action_check_ancestry ON product_action;
CREATE TRIGGER product_action_check_ancestry
  BEFORE INSERT OR UPDATE OF parent_action_id, product_id ON product_action
  FOR EACH ROW
  EXECUTE FUNCTION product_action_check_ancestry();

-- ---------------------------------------------------------------------------
-- A4 (update side) — a button may not change its type away from OPEN_SUBMENU
-- while it still has children, or those children become unreachable. Needs the
-- child rows, so it cannot be a CHECK.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION product_action_guard_menu_capability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  child_count integer;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.action_type = 'OPEN_SUBMENU'
     AND NEW.action_type <> 'OPEN_SUBMENU' THEN
    SELECT count(*) INTO child_count
      FROM product_action a
      WHERE a.parent_action_id = NEW.id;

    IF child_count > 0 THEN
      RAISE EXCEPTION
        'Button % has % child button(s), so its type cannot change away from OPEN_SUBMENU.',
        NEW.id, child_count
        USING ERRCODE = 'check_violation',
              HINT = 'Remove or re-parent the child buttons first.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_action_guard_menu_capability ON product_action;
CREATE TRIGGER product_action_guard_menu_capability
  BEFORE UPDATE OF action_type ON product_action
  FOR EACH ROW
  EXECUTE FUNCTION product_action_guard_menu_capability();

-- ---------------------------------------------------------------------------
-- Write-once inquiry context. `product_snapshot` and `selected_options` freeze
-- what the customer actually saw and chose, so a later re-price or catalog
-- restructure can never rewrite a conversation (DATA_MODEL.md §9.2). The
-- remaining inquiry columns — status, timestamps — stay fully mutable, and
-- `updated_at` is refreshed by the trigger above.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION inquiry_freeze_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.product_snapshot IS DISTINCT FROM OLD.product_snapshot THEN
    RAISE EXCEPTION
      'Inquiry % product snapshot is immutable after creation.',
      NEW.id
      USING ERRCODE = 'check_violation',
            HINT = 'The frozen price and product context record what the customer saw; it cannot be edited.';
  END IF;

  IF NEW.selected_options IS DISTINCT FROM OLD.selected_options THEN
    RAISE EXCEPTION
      'Inquiry % selected options are immutable after creation.',
      NEW.id
      USING ERRCODE = 'check_violation',
            HINT = 'The frozen button path records what the customer chose; it cannot be edited.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inquiry_freeze_context ON inquiry;
CREATE TRIGGER inquiry_freeze_context
  BEFORE UPDATE ON inquiry
  FOR EACH ROW
  EXECUTE FUNCTION inquiry_freeze_context();
