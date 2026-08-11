"""The slicer worker process: slicing a repaired 3MF, as stateless compute.

Deliberately re-exports nothing, for the reason `metrika_core.__init__` gives:
`mypy --strict` runs with `no_implicit_reexport`, and one import path per symbol
says which module owns what.

`python -m metrika_slicer` is the process. It differs from `metrika_geometry`
in exactly two things — the activities it registers and the task queue its
settings name — and everything else it needs lives in `metrika_core.temporal`,
so that the two entry points cannot drift apart.
"""
