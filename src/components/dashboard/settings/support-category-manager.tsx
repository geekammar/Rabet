"use client";

import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Edit2,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";

const SUGGESTIONS = ["General Question", "Product Support"] as const;

export function SupportCategoryManager({
  initialCategories = [],
  name = "supportCategory",
}: {
  initialCategories?: string[];
  name?: string;
}) {
  const [categories, setCategories] = useState<string[]>(initialCategories);
  const [newCategoryText, setNewCategoryText] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  function handleAddCategory(categoryToAdd?: string) {
    const text = (categoryToAdd ?? newCategoryText).trim();
    if (!text) {
      setInputError("Category name cannot be empty.");
      return;
    }
    if (text.length > 60) {
      setInputError("Category name cannot exceed 60 characters.");
      return;
    }
    if (categories.includes(text)) {
      setInputError("This category is already added.");
      return;
    }

    setCategories((prev) => [...prev, text]);
    if (!categoryToAdd) {
      setNewCategoryText("");
    }
    setInputError(null);
  }

  function handleRemoveCategory(index: number) {
    setCategories((prev) => prev.filter((_, i) => i !== index));
    if (editingIndex === index) {
      setEditingIndex(null);
    }
  }

  function handleStartEdit(index: number) {
    setEditingIndex(index);
    setEditingText(categories[index]);
    setInputError(null);
  }

  function handleSaveEdit(index: number) {
    const text = editingText.trim();
    if (!text) {
      setInputError("Category name cannot be empty.");
      return;
    }
    if (text.length > 60) {
      setInputError("Category name cannot exceed 60 characters.");
      return;
    }
    if (categories.some((c, i) => i !== index && c === text)) {
      setInputError("A category with this name already exists.");
      return;
    }

    setCategories((prev) =>
      prev.map((item, i) => (i === index ? text : item)),
    );
    setEditingIndex(null);
    setInputError(null);
  }

  function handleMoveUp(index: number) {
    if (index === 0) return;
    setCategories((prev) => {
      const next = [...prev];
      const temp = next[index - 1];
      next[index - 1] = next[index];
      next[index] = temp;
      return next;
    });
  }

  function handleMoveDown(index: number) {
    if (index === categories.length - 1) return;
    setCategories((prev) => {
      const next = [...prev];
      const temp = next[index + 1];
      next[index + 1] = next[index];
      next[index] = temp;
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {/* Hidden inputs for native form submission */}
      {categories.map((cat, idx) => (
        <input key={idx} type="hidden" name={name} value={cat} />
      ))}
      <input
        type="hidden"
        name="supportCategoriesJson"
        value={JSON.stringify(categories)}
      />

      <div className="space-y-1.5">
        <label
          htmlFor="add-category-input"
          className="text-sm font-medium text-foreground"
        >
          Support Categories
        </label>
        <p className="text-xs text-muted-foreground">
          Categories shown when a customer opens a support inquiry. (English-only at MVP)
        </p>
      </div>

      {/* Suggested chips */}
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Suggested examples:
        </span>
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((suggestion) => {
            const alreadyAdded = categories.includes(suggestion);
            return (
              <button
                key={suggestion}
                type="button"
                disabled={alreadyAdded}
                onClick={() => handleAddCategory(suggestion)}
                className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  alreadyAdded
                    ? "cursor-default border-muted bg-muted/40 text-muted-foreground opacity-60"
                    : "border-border bg-background text-foreground hover:bg-muted hover:border-foreground/30 active:scale-98"
                }`}
              >
                <Plus className="size-3" />
                <span>{suggestion}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Add new category input */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="add-category-input"
          type="text"
          value={newCategoryText}
          onChange={(e) => {
            setNewCategoryText(e.target.value);
            if (inputError) setInputError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAddCategory();
            }
          }}
          placeholder="e.g. Account Help, Refund Request"
          maxLength={60}
          className="flex min-h-11 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <Button
          type="button"
          variant="secondary"
          onClick={() => handleAddCategory()}
          className="min-h-11 gap-1.5 px-4"
        >
          <Plus className="size-4" />
          <span>Add Category</span>
        </Button>
      </div>

      {inputError ? (
        <p className="text-xs font-medium text-destructive">{inputError}</p>
      ) : null}

      {/* Category list */}
      {categories.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
          No support categories configured yet. Customers will see general inquiry support.
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Support category list">
          {categories.map((cat, index) => {
            const isEditing = editingIndex === index;

            return (
              <li
                key={index}
                className="flex items-center justify-between gap-2 rounded-lg border bg-card p-2 sm:px-3"
              >
                {isEditing ? (
                  <div className="flex flex-1 items-center gap-2">
                    <input
                      type="text"
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleSaveEdit(index);
                        } else if (e.key === "Escape") {
                          setEditingIndex(null);
                        }
                      }}
                      autoFocus
                      maxLength={60}
                      className="flex min-h-10 flex-1 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none focus-visible:border-ring focus-visible:ring-2"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      className="min-h-10 min-w-10 px-2"
                      onClick={() => handleSaveEdit(index)}
                      title="Save"
                    >
                      <Check className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="min-h-10 min-w-10 px-2"
                      onClick={() => setEditingIndex(null)}
                      title="Cancel"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <span className="flex-1 truncate text-sm font-medium text-foreground">
                      {cat}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        disabled={index === 0}
                        onClick={() => handleMoveUp(index)}
                        className="size-9 rounded-md text-muted-foreground hover:text-foreground disabled:opacity-30"
                        title="Move Up"
                        aria-label={`Move ${cat} up`}
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        disabled={index === categories.length - 1}
                        onClick={() => handleMoveDown(index)}
                        className="size-9 rounded-md text-muted-foreground hover:text-foreground disabled:opacity-30"
                        title="Move Down"
                        aria-label={`Move ${cat} down`}
                      >
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => handleStartEdit(index)}
                        className="size-9 rounded-md text-muted-foreground hover:text-foreground"
                        title="Edit"
                        aria-label={`Edit ${cat}`}
                      >
                        <Edit2 className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => handleRemoveCategory(index)}
                        className="size-9 rounded-md text-destructive hover:bg-destructive/10"
                        title="Delete"
                        aria-label={`Delete ${cat}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
