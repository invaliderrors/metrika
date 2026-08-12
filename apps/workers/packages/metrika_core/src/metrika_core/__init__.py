"""Shared library for both worker processes: settings, logging and S3.

Deliberately re-exports nothing. `mypy --strict` runs with
`no_implicit_reexport`, so a name would have to be listed here twice to be
importable from the package root, and one import path per symbol is worth more
than a shorter one — `from metrika_core.storage import ObjectStore` says which
module owns the boundary, which is the module this package exists to keep
narrow.
"""
