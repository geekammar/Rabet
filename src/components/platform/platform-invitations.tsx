"use client";

import { useActionState, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  ShieldCheck,
} from "lucide-react";

import {
  issuePlatformInvitation,
  revokePlatformInvitation,
  type PlatformIssueState,
  type PlatformRevokeState,
} from "@/app/actions/platform-invitations";
import { platformLogout } from "@/app/actions/platform-auth";
import { Logo } from "@/components/brand/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type PlatformInvitationView = {
  id: string;
  invitedEmail: string;
  storeName: string;
  storeSlug: string;
  storeStatus: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  issuedByEmail: string;
  revokedByEmail: string | null;
};

const STATUS_LABEL: Record<PlatformInvitationView["status"], string> = {
  pending: "Pending",
  accepted: "Redeemed",
  revoked: "Revoked",
  expired: "Expired",
};

const STATUS_VARIANT: Record<
  PlatformInvitationView["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "default",
  accepted: "secondary",
  revoked: "destructive",
  expired: "outline",
};

function formatUtc(iso: string): string {
  return `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(iso))} UTC`;
}

function IssueInvitationForm() {
  const [state, formAction, pending] = useActionState<
    PlatformIssueState,
    FormData
  >(issuePlatformInvitation, {});
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const issued = state?.issued;
  const inviteUrl =
    issued && typeof window !== "undefined"
      ? `${window.location.origin}${issued.invitePath}`
      : "";

  async function copyInviteLink() {
    if (!inviteUrl) return;

    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setCopyError(false);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="space-y-1">
        <h2 className="font-heading text-lg font-semibold">
          Issue a merchant invitation
        </h2>
        <p className="text-sm text-muted-foreground">
          Creates an onboarding store and a single-use invitation valid for 7
          days.
        </p>
      </div>

      <form action={formAction} className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <label htmlFor="invitedEmail" className="text-sm font-medium">
            Recipient email
          </label>
          <input
            id="invitedEmail"
            name="invitedEmail"
            type="email"
            inputMode="email"
            autoComplete="off"
            required
            className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            placeholder="owner@example.com"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="storeName" className="text-sm font-medium">
            Store name
          </label>
          <input
            id="storeName"
            name="storeName"
            type="text"
            required
            maxLength={255}
            className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            placeholder="Store name"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="storeSlug" className="text-sm font-medium">
            Store slug <span className="text-muted-foreground">(optional)</span>
          </label>
          <input
            id="storeSlug"
            name="storeSlug"
            type="text"
            maxLength={100}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            placeholder="my-store"
          />
        </div>

        <div className="sm:col-span-2">
          <Button type="submit" className="min-h-11" disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {pending ? "Issuing…" : "Issue invitation"}
          </Button>
        </div>
      </form>

      {state?.status === "error" ? (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {state.message}
        </p>
      ) : null}

      {issued ? (
        <div
          className="mt-5 space-y-4 rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/30"
          data-testid="platform-issued-invitation"
        >
          <div className="flex items-start gap-2">
            <Check
              className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-300"
              aria-hidden="true"
            />
            <div className="space-y-1 text-sm">
              <p className="font-medium text-emerald-900 dark:text-emerald-100">
                {state?.message}
              </p>
              <p className="text-emerald-800 dark:text-emerald-200/90">
                {issued.storeName} ({issued.storeSlug}) → {issued.invitedEmail}
              </p>
              <p className="text-emerald-800 dark:text-emerald-200/90">
                Expires {formatUtc(issued.expiresAt)}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="issuedInvitationLink"
              className="text-sm font-medium text-emerald-900 dark:text-emerald-100"
            >
              Invitation link
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="issuedInvitationLink"
                type="text"
                readOnly
                value={inviteUrl}
                onFocus={(event) => event.currentTarget.select()}
                className="min-h-11 w-full rounded-lg border border-emerald-300 bg-background px-3 font-mono text-xs text-foreground shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:border-emerald-900/50"
                data-testid="platform-invitation-link"
              />
              <Button
                type="button"
                variant="outline"
                className="min-h-11 shrink-0"
                onClick={() => void copyInviteLink()}
                data-testid="platform-copy-invitation-link"
              >
                {copied ? (
                  <Check className="size-4" aria-hidden="true" />
                ) : (
                  <Copy className="size-4" aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy link"}
              </Button>
            </div>
            {copyError ? (
              <p className="text-xs text-destructive">
                Copy failed. Select the link and copy it manually.
              </p>
            ) : null}
            <a
              href={issued.invitePath}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium text-emerald-800 underline underline-offset-4 dark:text-emerald-200"
            >
              Open invitation
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RevokeInvitation({ invitationId }: { invitationId: string }) {
  const [state, formAction, pending] = useActionState<
    PlatformRevokeState,
    FormData
  >(revokePlatformInvitation, {});

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (
          !window.confirm(
            "Revoke this invitation? The link will stop working immediately.",
          )
        ) {
          event.preventDefault();
        }
      }}
      className="space-y-1"
    >
      <input type="hidden" name="invitationId" value={invitationId} />
      <Button
        type="submit"
        variant="destructive"
        size="sm"
        disabled={pending}
        className="min-h-9"
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : null}
        {pending ? "Revoking…" : "Revoke"}
      </Button>
      {state?.status === "error" ? (
        <p role="alert" className="max-w-56 text-xs text-destructive">
          {state.message}
        </p>
      ) : null}
      {state?.status === "success" ? (
        <p role="status" className="max-w-56 text-xs text-muted-foreground">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function PlatformInvitations({
  adminEmail,
  invitations,
}: {
  adminEmail: string;
  invitations: PlatformInvitationView[];
}) {
  const pendingCount = invitations.filter(
    (invitation) => invitation.status === "pending",
  ).length;

  return (
    <div
      dir="ltr"
      lang="en"
      className="flex min-h-dvh w-full flex-col bg-background"
      data-testid="platform-invitations-page"
    >
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Logo className="text-lg" />
            <span className="hidden text-sm text-muted-foreground sm:inline">
              Platform administration
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden max-w-64 truncate text-sm text-muted-foreground sm:inline">
              {adminEmail}
            </span>
            <form action={platformLogout}>
              <Button type="submit" variant="outline" size="sm" className="min-h-9">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              Merchant invitations
            </h1>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <ShieldCheck className="size-4" aria-hidden="true" />
              Signed in as a platform Super Admin
            </p>
          </div>
          <Badge variant="outline" className="h-7 px-3 text-sm">
            {pendingCount} pending
          </Badge>
        </div>

        <IssueInvitationForm />

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-heading text-lg font-semibold">
              Invitation history
            </h2>
            <p className="text-sm text-muted-foreground">
              {invitations.length} record{invitations.length === 1 ? "" : "s"}
            </p>
          </div>

          {invitations.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No invitations have been issued yet.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="min-w-full divide-y divide-border text-sm">
                <thead className="bg-muted/40 text-left">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Recipient
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Store
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Expiry
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Issued by
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Revoked by
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border bg-card">
                  {invitations.map((invitation) => (
                    <tr
                      key={invitation.id}
                      data-testid={`platform-invitation-${invitation.id}`}
                    >
                      <td className="px-3 py-3 align-top">
                        <p className="break-all font-medium">
                          {invitation.invitedEmail}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Issued {formatUtc(invitation.createdAt)}
                        </p>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <p className="font-medium">{invitation.storeName}</p>
                        <p className="text-xs text-muted-foreground">
                          {invitation.storeSlug} · {invitation.storeStatus}
                        </p>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <Badge variant={STATUS_VARIANT[invitation.status]}>
                          {STATUS_LABEL[invitation.status]}
                        </Badge>
                        {invitation.acceptedAt ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {formatUtc(invitation.acceptedAt)}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 align-top whitespace-nowrap">
                        {formatUtc(invitation.expiresAt)}
                      </td>
                      <td className="px-3 py-3 align-top">
                        <span className="break-all text-xs text-muted-foreground">
                          {invitation.issuedByEmail}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-top">
                        {invitation.revokedByEmail ? (
                          <>
                            <span className="break-all text-xs text-muted-foreground">
                              {invitation.revokedByEmail}
                            </span>
                            {invitation.revokedAt ? (
                              <p className="text-xs text-muted-foreground">
                                {formatUtc(invitation.revokedAt)}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 align-top">
                        {invitation.status === "pending" ? (
                          <RevokeInvitation invitationId={invitation.id} />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
