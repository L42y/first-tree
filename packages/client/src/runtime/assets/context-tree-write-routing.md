Tree writes are source-driven. When a concrete source artifact (for example, a
PR/MR, forge Issue, design doc, meeting or decision note, commit discussion or
review thread, or pasted source) changes a durable decision, constraint, owner,
or cross-domain relationship, load `first-tree-write` and make the smallest
correct Tree diff. This standing route makes the required Tree node files part
of the task. Implementation-only changes skip the Tree write, but not the
preceding Tree read.

Without a concrete source artifact, there is no Tree write task.

When code and Tree PRs/MRs are both needed, create and cross-link both, keep the
Tree change draft, merge source first, reconcile it against merged source truth,
then mark the Tree change ready.
