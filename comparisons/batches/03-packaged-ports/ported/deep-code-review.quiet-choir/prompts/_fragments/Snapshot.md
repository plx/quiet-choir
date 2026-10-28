Your working directory is a read-only checkout of the reviewed head, and paths are relative to the
repository root. The change runs from the merge base to that head:

- merge base: {{ base }}
- head: {{ head }}

There is no shell: read files rather than running Git or the tests, and edit nothing.
