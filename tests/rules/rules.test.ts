import { describe, expect, it } from "vitest";
import fs from "node:fs";
describe("security rules", () => {
  const firestore = fs.readFileSync("firestore.rules", "utf8");
  const indexes = JSON.parse(fs.readFileSync("firestore.indexes.json", "utf8")) as {
    indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order: string }> }>;
  };
  const storage = fs.readFileSync("storage.rules", "utf8");
  it("prevents direct credit and runtime writes", () => {
    expect(firestore).toContain("match /creditWallets/{uid}");
    expect(firestore).toContain(
      "match /generations/{id} { allow read, write: if false; }",
    );
    expect(firestore).toContain("match /runtimeState/{id}");
    expect(firestore).toContain("match /generationQueue/{id}");
    expect(firestore).toContain("match /generationIdempotency/{id}");
    expect(firestore).toContain("match /generationActive/{id}");
    expect(firestore).toContain("match /storyboardAsyncJobs/{id}");
    expect(firestore).toContain("match /storyboardAsyncIdempotency/{id}");
    expect(firestore).toContain("match /storyboardAsyncActive/{id}");
  });
  it("scopes storage uploads by uid and content type", () => {
    expect(storage).toContain("match /users/{uid}/uploads/{fileName}");
    expect(storage).toContain("allow read, write: if false");
    expect(firestore).toContain("match /storyboardDrafts/{uid}");
    expect(firestore).toContain("match /storyboardProjects/{id}");
    expect(firestore).toContain("match /storyboardDirectorProposals/{id}");
    expect(firestore).toContain("match /projectDeletionQueue/{id}");
    expect(firestore).toContain(
      "match /systemMetrics/{id} { allow read, write: if false; }",
    );
  });
  it("indexes owner-scoped Director proposal history", () => {
    expect(indexes.indexes).toContainEqual({
      collectionGroup: "storyboardDirectorProposals",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "uid", order: "ASCENDING" },
        { fieldPath: "projectId", order: "ASCENDING" },
        { fieldPath: "createdAt", order: "DESCENDING" },
      ],
    });
  });
  it("indexes durable Director queue claims and lease recovery", () => {
    expect(indexes.indexes).toContainEqual({
      collectionGroup: "storyboardAsyncJobs",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "status", order: "ASCENDING" },
        { fieldPath: "createdAt", order: "ASCENDING" },
      ],
    });
    expect(indexes.indexes).toContainEqual({
      collectionGroup: "storyboardAsyncJobs",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "status", order: "ASCENDING" },
        { fieldPath: "leaseExpiresAt", order: "ASCENDING" },
      ],
    });
  });
});
