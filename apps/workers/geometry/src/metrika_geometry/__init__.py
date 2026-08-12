"""The geometry worker process: mesh analysis and repair, as stateless compute.

Deliberately re-exports nothing, for the reason `metrika_core.__init__` gives:
`mypy --strict` runs with `no_implicit_reexport`, and one import path per symbol
says which module owns what.

`python -m metrika_geometry` is the process. `activities.py` is what it
registers; `__main__.py` is the entry point and holds no domain logic, so that
what a container runs is legible in fifteen lines.
"""
