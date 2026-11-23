import { Badge } from "@/components/ui/badge";
import { PlatformHeader } from "@/components/platform/platform-header";
import { PlatformNav } from "@/components/platform/platform-nav";

type StoreLifecycle = "onboarding" | "active" | "suspended";
type InvitationState = "pending" | "accepted" | "revoked" | "expired";

export type PlatformStoreDirectoryView = {
  id: string;
  name: string;
  slug: string;
  status: StoreLifecycle;
  ownerEmails: string[];
  latestInvitation: {
    id: string;
    invitedEmail: string;
    status: InvitationState;
    expiresAt: string;
    createdAt: string;
    acceptedAt: string | null;
    revokedAt: string | null;
  } | null;
};

const STORE_STATUS_LABEL: Record<StoreLifecycle, string> = {
  onboarding: "Onboarding",
  active: "Active",
  suspended: "Suspended",
};

const STORE_STATUS_VARIANT: Record<
  StoreLifecycle,
  "default" | "secondary" | "destructive"
> = {
  onboarding: "secondary",
  active: "default",
  suspended: "destructive",
};

const INVITATION_STATUS_LABEL: Record<InvitationState, string> = {
  pending: "Invitation pending",
  accepted: "Invitation accepted",
  revoked: "Invitation revoked",
  expired: "Invitation expired",
};

const INVITATION_STATUS_VARIANT: Record<
  InvitationState,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  accepted: "default",
  revoked: "destructive",
  expired: "secondary",
};

function formatUtc(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return "Unknown time";

  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function invitationDetail(
  invitation: NonNullable<PlatformStoreDirectoryView["latestInvitation"]>,
): string {
  if (invitation.status === "accepted" && invitation.acceptedAt) {
    return `Accepted ${formatUtc(invitation.acceptedAt)}`;
  }

  if (invitation.status === "revoked" && invitation.revokedAt) {
    return `Revoked ${formatUtc(invitation.revokedAt)}`;
  }

  if (invitation.status === "expired") {
    return `Expired ${formatUtc(invitation.expiresAt)}`;
  }

  return `Expires ${formatUtc(invitation.expiresAt)}`;
}

export function PlatformStoreDirectory({
  adminEmail,
  stores,
}: {
  adminEmail: string;
  stores: PlatformStoreDirectoryView[];
}) {
  const withOwner = stores.filter((store) => store.ownerEmails.length > 0).length;
  const withoutInvitation = stores.filter(
    (store) => store.latestInvitation === null,
  ).length;

  return (
    <div
      dir="ltr"
      lang="en"
      className="flex min-h-dvh w-full flex-col bg-background"
      data-testid="platform-stores-page"
    >
      <PlatformHeader adminEmail={adminEmail} />

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <PlatformNav active="stores" />

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              Stores
            </h1>
            <p className="text-sm text-muted-foreground">
              Read-only directory of every store, its owner account and latest
              invitation.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="h-7 px-3 text-sm">
              {stores.length} store{stores.length === 1 ? "" : "s"}
            </Badge>
            <Badge variant="secondary" className="h-7 px-3 text-sm">
              {withOwner} with account
            </Badge>
            <Badge variant="outline" className="h-7 px-3 text-sm">
              {withoutInvitation} without invitation
            </Badge>
          </div>
        </div>

        {stores.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No stores exist yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="min-w-[760px] divide-y divide-border text-sm">
              <thead className="bg-muted/40 text-left">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Store
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Lifecycle
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Owner account
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Latest invitation
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {stores.map((store) => (
                  <tr
                    key={store.id}
                    data-testid={`platform-store-${store.id}`}
                  >
                    <td className="px-3 py-3 align-top">
                      <p className="break-words font-medium">{store.name}</p>
                      <p className="break-all text-xs text-muted-foreground">
                        {store.slug}
                      </p>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <Badge variant={STORE_STATUS_VARIANT[store.status]}>
                        {STORE_STATUS_LABEL[store.status]}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 align-top">
                      {store.ownerEmails.length > 0 ? (
                        <div className="space-y-1">
                          {store.ownerEmails.map((email) => (
                            <p
                              key={email}
                              className="break-all text-sm font-medium"
                            >
                              {email}
                            </p>
                          ))}
                        </div>
                      ) : (
                        <span
                          className="text-sm text-muted-foreground"
                          data-testid={`platform-store-no-account-${store.id}`}
                        >
                          No account yet
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      {store.latestInvitation ? (
                        <div className="space-y-1">
                          <p className="break-all text-sm font-medium">
                            {store.latestInvitation.invitedEmail}
                          </p>
                          <Badge
                            variant={
                              INVITATION_STATUS_VARIANT[
                                store.latestInvitation.status
                              ]
                            }
                          >
                            {
                              INVITATION_STATUS_LABEL[
                                store.latestInvitation.status
                              ]
                            }
                          </Badge>
                          <p className="text-xs text-muted-foreground">
                            {invitationDetail(store.latestInvitation)}
                          </p>
                        </div>
                      ) : (
                        <span
                          className="text-sm text-muted-foreground"
                          data-testid={`platform-store-no-invitation-${store.id}`}
                        >
                          No invitation
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
