Behavior preservation is the invariant. Observable behavior is what a caller can see: return
values, thrown errors and their messages, side effects and their order, and the public names and
signatures. Preserve all of it, bugs included; fixing a bug here is a behavior change.
