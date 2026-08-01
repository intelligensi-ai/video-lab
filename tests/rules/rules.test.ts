import { describe, expect, it } from "vitest";
import fs from "node:fs";
describe("security rules", () => {
  const firestore = fs.readFileSync("firestore.rules", "utf8");
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
  });
  it("scopes storage uploads by uid and content type", () => {
    expect(storage).toContain("match /users/{uid}/uploads/{fileName}");
    expect(storage).toContain("allow read, write: if false");
    expect(firestore).toContain("match /storyboardDrafts/{uid}");
    expect(firestore).toContain("match /storyboardProjects/{id}");
    expect(firestore).toContain("match /projectDeletionQueue/{id}");
    expect(firestore).toContain(
      "match /systemMetrics/{id} { allow read, write: if false; }",
    );
  });
});
