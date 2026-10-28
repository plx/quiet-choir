Map the attack surface of {{ scope }} for a defensive security audit. Specialist auditors work from
your map next ({{ lenses | join(', ') }}), so make it specific to this codebase. Report the map
only; do not audit yet.

Find:

1. every entry point where external data enters: HTTP routes, CLI arguments, file and queue
   consumers, webhooks;
2. the trust boundaries, where authentication and authorization decisions happen, and what each one
   protects;
3. everywhere secrets (credentials, tokens, keys) are read, stored or transmitted;
4. the security-relevant third-party dependencies (crypto, auth, parsers) with their versions.

Name each item by its file and, where it helps, its function or route, so an auditor can go
straight to it. Any list may be empty. Finish with a short summary of the surface.

{% include "_fragments/Snapshot.md" +%}

{% include "_fragments/Evidence.md" +%}

{% include "_fragments/Defensive.md" %}
