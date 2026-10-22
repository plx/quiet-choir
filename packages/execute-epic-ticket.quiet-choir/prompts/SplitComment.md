{{ issueComment }}

Slices: {% for n in slices %}#{{ n }}{% if not loop.last %}, {% endif %}{% endfor %}. This ticket closes when they have all landed.

<details><summary>Planning notes</summary>

{{ rationale }}

</details>

<!-- epic:split {{ slices | join(',') }} -->
