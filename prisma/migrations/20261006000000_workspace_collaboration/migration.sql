CREATE TYPE "WorkspaceInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

ALTER TABLE "Document"
    ADD COLUMN "uploadedByUserId" TEXT;

ALTER TABLE "Document"
    ADD CONSTRAINT "Document_uploadedByUserId_fkey"
    FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Document_uploadedByUserId_idx" ON "Document"("uploadedByUserId");

CREATE UNIQUE INDEX "WorkspaceMember_one_owner_per_workspace_idx"
    ON "WorkspaceMember"("workspaceId") WHERE "role" = 'OWNER';

CREATE TABLE "WorkspaceInvitation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "tokenHash" TEXT NOT NULL,
    "status" "WorkspaceInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invitedByUserId" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "WorkspaceInvitation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkspaceInvitation_role_check" CHECK ("role" <> 'OWNER')
);

ALTER TABLE "WorkspaceInvitation"
    ADD CONSTRAINT "WorkspaceInvitation_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceInvitation"
    ADD CONSTRAINT "WorkspaceInvitation_invitedByUserId_fkey"
    FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "WorkspaceInvitation_workspaceId_email_key"
    ON "WorkspaceInvitation"("workspaceId", "email");
CREATE UNIQUE INDEX "WorkspaceInvitation_tokenHash_key" ON "WorkspaceInvitation"("tokenHash");
CREATE INDEX "WorkspaceInvitation_workspaceId_status_expiresAt_idx"
    ON "WorkspaceInvitation"("workspaceId", "status", "expiresAt");
