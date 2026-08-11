r"""The TypeScript-to-Python contract boundary, asserted from the Python side.

This is the only place the boundary's failures are observable. `packages/
contracts` has correct-looking Zod on its side of every divergence found so far,
and every one of them was invisible to its own tests:

  * `money.ts` spelled its digit class `\d`. Identical to `[0-9]` in JavaScript,
    Unicode-aware in Python -- so the generated model accepted "3\u0665\u0660",
    which Zod rejects and `BigInt` throws on, and read it as 350.
  * `brand.ts` carried an `/i` flag, and `z.toJSONSchema()` drops flags silently,
    so Zod accepted `A1B2C3D4-...` and the emitted pattern rejected it. That one
    affected every branded ID in the system.

Both are fixed and guarded on the TypeScript side. The lasting lesson is that
this boundary hides divergence in BOTH directions and neither side's own tests
can see it, so the assertions here are behavioural: every model is INSTANTIATED
and a payload is VALIDATED through it.

That is not a stylistic preference. ADR-0027 obligation 5 measured a generated
model carrying both `format: date-time` and a `pattern` -- exactly what
`z.iso.datetime()` emits -- passing `ruff check`, `ruff format --check`,
`mypy --strict` AND `import` at exit 0, and then raising an uncaught `TypeError`
on every single payload. Four green gates and a model that had never validated
anything. Importing proves nothing here.

Non-ASCII digits are written as `\u` escapes throughout rather than as
themselves: ruff's RUF001/RUF002/RUF003 report an Arabic-Indic digit in source
as an ambiguous character, and it is -- that ambiguity is the entire subject of
this file.
"""

from __future__ import annotations

import re
import sys
import tomllib
from collections.abc import Mapping
from enum import Enum
from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError

from metrika_core import contracts
from metrika_core.contracts import CurrencyCode, DomainErrorCode, Money, OrderId, QuoteId

WORKERS_ROOT = Path(__file__).resolve().parents[3]
GENERATED = Path(contracts.__file__)

MODULE = "metrika_core.contracts"

VALID_UUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4051"

# ASCII 3 followed by two Arabic-Indic digits. ADR-0027's canonical probe:
# `int()` reads it as 350 in Python, `BigInt` on the same string throws, and
# Zod's regex does not match it.
ARABIC_INDIC_MONEY = "3\u0665\u0660"

_ASCII_TO_ARABIC_INDIC = str.maketrans(
    "0123456789",
    "\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669",
)


def _to_arabic_indic(value: str) -> str:
    return value.translate(_ASCII_TO_ARABIC_INDIC)


def _generated_classes() -> dict[str, type]:
    """Every class the generator actually wrote, by name.

    Filtered on `__module__`, not on `issubclass`: the generated file imports
    `BaseModel`, `RootModel` and `StrEnum` into its own namespace, and grading
    those would be grading pydantic.
    """
    return {
        name: obj
        for name, obj in vars(contracts).items()
        if isinstance(obj, type) and obj.__module__ == MODULE
    }


def _generated_models() -> dict[str, type[BaseModel]]:
    return {name: obj for name, obj in _generated_classes().items() if issubclass(obj, BaseModel)}


def _generated_enums() -> dict[str, type[Enum]]:
    return {name: obj for name, obj in _generated_classes().items() if issubclass(obj, Enum)}


def _patterns(node: object) -> list[str]:
    """Every `pattern` anywhere in a model's ROUND-TRIPPED JSON Schema.

    Used ONLY to answer "did pydantic actually apply this constraint", never to
    answer "what patterns crossed the boundary". See `_source_patterns`.
    """
    if isinstance(node, list):
        return [found for item in node for found in _patterns(item)]
    if isinstance(node, Mapping):
        pattern = node.get("pattern")
        here = [pattern] if isinstance(pattern, str) else []
        return here + [found for value in node.values() for found in _patterns(value)]
    return []


_CLASS_LINE = re.compile(r"^class (\w+)\(")
_SOURCE_PATTERN = re.compile(r'pattern="((?:[^"\\]|\\.)*)"')


def _source_patterns() -> dict[str, list[str]]:
    r"""Every `pattern=` in the GENERATED SOURCE, by the class it appears under.

    Read from the file rather than from `model_json_schema()`, and that is the
    difference between a guard and a decoration.

    MEASURED, with `z.iso.datetime()` added to the emitted set: the generator
    writes `Annotated[AwareDatetime, Field(pattern="^\d{4}-...")]`, pydantic
    CANNOT apply a string pattern to a datetime, and it drops the constraint
    SILENTLY -- `Timestamp.model_json_schema()` comes back as
    `{"format": "date-time", "title": "Timestamp", "type": "string"}` with no
    `pattern` at all. A guard reading the round-tripped schema therefore sees
    nothing and passes, against a model that raises `TypeError` on every payload.
    `z.iso.date()` and `z.iso.time()` are in the same blind spot; only
    `z.e164()`, which is a plain string, would have been caught.

    The generated file is also the artefact CI byte-diffs, so this reads exactly
    what is under review.

    The regex tolerates a `\"` escape inside the literal for completeness; no
    emitted pattern contains one today, and one that did would be visible as an
    unexpected entry rather than a silently truncated one.
    """
    found: dict[str, list[str]] = {}
    current = ""

    for line in GENERATED.read_text(encoding="utf-8").splitlines():
        class_line = _CLASS_LINE.match(line)
        if class_line:
            current = class_line.group(1)
            continue
        for pattern in _SOURCE_PATTERN.findall(line):
            found.setdefault(current, []).append(pattern)

    return found


# A valid payload for EVERY generated model, so that "instantiate and validate"
# is total rather than a spot check. `test_every_generated_model_has_a_sample`
# fails if a model is added and this table is not extended -- which is the point:
# a new contract crossing the boundary untested is exactly the gap ADR-0027
# obligation 5 exists to close.
VALID_PAYLOADS: dict[str, object] = {
    # The document root. Not a contract -- it is the container the generator
    # names after the JSON Schema document, and it has no fields.
    "MetrikaContracts": {},
    "Money": {"amountMinor": "350000", "currency": "COP", "exponent": 0},
    "Millimeters": -12.5,
    "SquareMillimeters": 40.0,
    "CubicMillimeters": 1500.0,
    "Grams": 12.5,
    "Seconds": 90.0,
    "UserId": VALID_UUID,
    "OrganizationId": VALID_UUID,
    "ProjectId": VALID_UUID,
    "ModelId": VALID_UUID,
    "ModelVersionId": VALID_UUID,
    "QuoteId": VALID_UUID,
    "OrderId": VALID_UUID,
    "SliceJobId": VALID_UUID,
    "PrintJobId": VALID_UUID,
    "MaterialId": VALID_UUID,
    "PrinterProfileVersionId": VALID_UUID,
}

# A payload that must be REJECTED by every pattern-carrying model, and its ASCII
# TWIN, which must be accepted. The pair is the whole design: the probe differs
# from the twin only in which digits it spells, so a rejection here can only be
# about the digits.
#
# CAUGHT BY A MUTATION, and recorded because it is the shape this repository
# keeps meeting. The Money probe was first written as the bare string
# "3\u0665\u0660". `Money` is an OBJECT model, so `model_validate` rejected it as
# `model_attributes_type` -- the right exception for the wrong reason -- and this
# test passed under a mutation that put `\d` back into the pattern. Measured
# separately on the pinned pydantic 2.13.4: with `\d`, the default rust-regex
# engine AND `python-re` AND `re.match` all ACCEPT "3\u0665\u0660", and `int()`
# reads it as 350. The twin is what makes a wrong-shaped probe impossible to miss.
NON_ASCII_DIGIT_PROBES: dict[str, object] = {
    "Money": {"amountMinor": ARABIC_INDIC_MONEY, "currency": "COP", "exponent": 0},
    **{name: _to_arabic_indic(VALID_UUID) for name in VALID_PAYLOADS if name.endswith("Id")},
}

ASCII_TWINS: dict[str, object] = {
    "Money": {"amountMinor": "350", "currency": "COP", "exponent": 0},
    **{name: VALID_UUID for name in VALID_PAYLOADS if name.endswith("Id")},
}

# The five branded units, which are the ones CLAUDE.md says flow into money, and
# which the Python side PRODUCES rather than merely reads -- a geometry or slicer
# worker is where a volume or a mass comes from in the first place.
NUMERIC_MODELS = (
    "Millimeters",
    "SquareMillimeters",
    "CubicMillimeters",
    "Grams",
    "Seconds",
)

# Everything `z.number()` rejects and a bare pydantic `float` does not.
#
# MEASURED before the fix, on the pinned pydantic 2.13.4:
#
#   Millimeters  NaN=ACCEPT  +inf=ACCEPT  -inf=ACCEPT  "12.5"=ACCEPT  True=ACCEPT
#   Grams        NaN=reject  +inf=ACCEPT  -inf=reject  "12.5"=ACCEPT  True=ACCEPT
#
# and the four non-negative units' partial protection was ACCIDENTAL: `ge=0`
# happens to filter NaN (every comparison with it is false) and `-inf`, while
# `+inf >= 0` passes. `Millimeters` has no lower bound and so had none of it.
#
# Two changes close this, and neither is expressible without the other:
#   * `units.ts` carries `minimum`/`maximum` at ±Number.MAX_VALUE, which is
#     exactly the set of finite doubles. JSON Schema has no `finite` keyword;
#     these two it does have.
#   * `--strict-types` stops "12.5" and True being read as floats.
NON_FINITE_AND_COERCED: tuple[tuple[str, object], ...] = (
    ("NaN", float("nan")),
    ("+inf", float("inf")),
    ("-inf", float("-inf")),
    ("numeric string", "12.5"),
    ("bool", True),
)

# What a unit must still ACCEPT afterwards. `z.number()` takes any finite
# number, so an int is valid input and a model that rejected one would be a
# reverse divergence -- Python refusing a payload TypeScript emits.
FINITE_ACCEPTED: tuple[object, ...] = (0, 12, 12.5, 1.0e300)


def test_the_reflection_finds_the_generated_module() -> None:
    """Non-vacuity. Every test below is driven by the walk above."""
    classes = _generated_classes()

    assert len(classes) >= 20, f"only found {sorted(classes)}"
    assert "Money" in classes
    assert "QuoteId" in classes
    assert "CurrencyCode" in _generated_enums()
    assert "BaseModel" not in classes, "the walk is grading pydantic, not the contracts"


# ------------------------- instantiate and validate --------------------------


def test_every_generated_model_has_a_sample() -> None:
    assert set(VALID_PAYLOADS) == set(_generated_models()), (
        "a generated model has no payload in VALID_PAYLOADS, so nothing proves it can "
        "validate anything at all -- see ADR-0027 obligation 5"
    )


@pytest.mark.parametrize("name", sorted(VALID_PAYLOADS))
def test_every_generated_model_validates_a_real_payload(name: str) -> None:
    """ADR-0027 obligation 5, applied to every model rather than one.

    `TypeError` is caught and re-raised with a pointed message because it is the
    measured failure shape: a constraint the generator applied to a type that
    cannot carry it produces an uncaught `TypeError` -- not a `ValidationError`
    -- on the first real payload, in a worker, at runtime.
    """
    model = _generated_models()[name]
    try:
        model.model_validate(VALID_PAYLOADS[name])
    except TypeError as error:
        pytest.fail(
            f"{name} loads but cannot validate: {error!r}. A constraint has been applied "
            "to a type that cannot carry it (ADR-0027: `format: date-time` + `pattern`)."
        )


@pytest.mark.parametrize("enum_name", sorted(_generated_enums()))
def test_every_generated_enum_round_trips_a_member_and_rejects_a_stranger(
    enum_name: str,
) -> None:
    """Parametrized over what the module ACTUALLY defines, not a hard-coded pair.

    A hard-coded list means a new enum crosses the boundary with no behavioural
    assertion at all, and nothing on this side says so.
    """
    enum = _generated_enums()[enum_name]
    member = next(iter(enum))

    assert enum(member.value) is member
    with pytest.raises(ValueError, match="is not a valid"):
        enum("__NOT_A_MEMBER__")


def test_the_enum_walk_is_not_empty() -> None:
    """The parametrization above is silently vacuous if the walk finds nothing."""
    assert set(_generated_enums()) >= {"CurrencyCode", "DomainErrorCode"}


# ------------------------- numbers, and finiteness ---------------------------


def test_the_numeric_model_list_is_every_numeric_model() -> None:
    """Non-vacuity for the two tests below.

    Derived from the models rather than trusted: a sixth unit added to
    `units.ts` must appear here, or the probes below silently stop covering the
    whole set.
    """
    numeric = {
        name
        for name, model in _generated_models().items()
        if isinstance(VALID_PAYLOADS.get(name), float)
    }

    assert numeric == set(NUMERIC_MODELS)


@pytest.mark.parametrize("name", NUMERIC_MODELS)
@pytest.mark.parametrize(
    "value",
    [pytest.param(value, id=label) for label, value in NON_FINITE_AND_COERCED],
)
def test_no_numeric_model_accepts_a_non_finite_or_coerced_value(name: str, value: object) -> None:
    """The finiteness half of the boundary, and it is the same family as `\\d`.

    `z.number()` rejects NaN, +inf, -inf, "12.5" and True. A bare pydantic float
    accepts all five, so the generated model would be strictly more permissive
    than the schema defining it -- on the five quantities that flow into money,
    produced by the side that has no Zod. `units.ts` says it plainly: a slicer
    result must be an exact number or absent, never an unbounded one. A NaN
    millimetre reaching the pricing kernel is what this whole boundary exists to
    prevent.
    """
    with pytest.raises(ValidationError):
        _generated_models()[name].model_validate(value)


@pytest.mark.parametrize("name", NUMERIC_MODELS)
def test_every_numeric_model_still_accepts_finite_numbers(name: str) -> None:
    """The other direction, which is what stops the fix being a bigger bug.

    A model that rejected `12` or `1e300` would refuse payloads TypeScript
    happily emits -- the `brand.ts` `/i` failure, in numbers. `Millimeters` takes
    negatives (coordinates); the other four are non-negative by their own Zod
    schema, so they are exercised on the non-negative subset.
    """
    model = _generated_models()[name]
    for value in FINITE_ACCEPTED:
        model.model_validate(value)
    if name == "Millimeters":
        model.model_validate(-12.5)


@pytest.mark.parametrize("name", NUMERIC_MODELS)
def test_every_numeric_model_carries_the_finite_bounds(name: str) -> None:
    """The bounds are a no-op on the Zod side, which is how they get deleted.

    They are the ONLY thing carrying finiteness across, so this asserts they
    arrived rather than trusting the behavioural tests to notice a schema whose
    author thought `.max(Number.MAX_VALUE)` was noise.
    """
    schema = _generated_models()[name].model_json_schema()

    assert schema.get("maximum") == sys.float_info.max, schema
    assert schema.get("minimum") == (-sys.float_info.max if name == "Millimeters" else 0.0), schema


# --------------------------------- money -------------------------------------


def test_money_rejects_a_decimal_string() -> None:
    """The assertion the whole boundary exists for.

    Without the emitted `pattern`, this model accepts "3500.00" and float money
    re-enters the system at the language boundary -- the one place no TypeScript
    test can see it.
    """
    with pytest.raises(ValidationError):
        Money(amountMinor="3500.00", currency=CurrencyCode.COP, exponent=0)


def test_money_accepts_a_canonical_integer_string() -> None:
    money = Money(amountMinor="350000", currency=CurrencyCode.COP, exponent=0)

    assert money.amountMinor == "350000"
    assert money.model_dump()["amountMinor"] == "350000"


@pytest.mark.parametrize(
    "amount",
    ["3.5e5", "0350", "+350", "-0", "", " 350", "350 ", "abc", "1_000", "3500.00"],
)
def test_money_rejects_every_non_canonical_amount(amount: str) -> None:
    with pytest.raises(ValidationError):
        Money(amountMinor=amount, currency=CurrencyCode.COP, exponent=0)


def test_money_does_not_coerce_a_machine_integer_to_a_string() -> None:
    """A Python caller must not be able to smuggle a machine number through.

    pydantic v2 does not widen `int` to `str`, so this raises `string_type`. The
    field exists to keep money out of floats; an `int` here is a `float` two
    conversions later. Asserted at RUNTIME rather than left to the type checker:
    the pydantic mypy plugin synthesises `__init__(**kwargs)` untyped by default,
    so mypy has no opinion about this call at all.
    """
    with pytest.raises(ValidationError):
        Money(amountMinor=350000, currency=CurrencyCode.COP, exponent=0)


@pytest.mark.parametrize("exponent", [-1, 5, 100])
def test_money_rejects_an_out_of_range_exponent(exponent: int) -> None:
    with pytest.raises(ValidationError):
        Money(amountMinor="350000", currency=CurrencyCode.COP, exponent=exponent)


@pytest.mark.parametrize("exponent", ["2", True])
def test_money_does_not_coerce_a_string_or_bool_into_the_exponent(exponent: object) -> None:
    """`z.number().int()` rejects both; lax pydantic reads them as 2 and 1.

    An exponent is how many minor units make one major unit -- reading `True` as
    `1` would render COP with one decimal place, silently, on a stored quote.
    `--strict-types` is what closes this.
    """
    with pytest.raises(ValidationError):
        Money(amountMinor="350000", currency=CurrencyCode.COP, exponent=exponent)


def test_the_one_place_this_side_is_stricter_than_zod_is_named() -> None:
    """`exponent=2.0` is rejected here and ACCEPTED by Zod, and that is on purpose.

    JavaScript has one number type, so `z.number().int()` sees `2.0` as `2` and
    takes it. Python does not, and `StrictInt` refuses a float. That is a reverse
    divergence -- the direction that broke `brand.ts` -- so it is asserted rather
    than left to be discovered.

    It is UNREACHABLE ON THE WIRE, which is why it is an acceptable price for the
    two coercions above: `JSON.stringify(2)` emits `2`, never `2.0`, so no
    payload TypeScript produces can carry the rejected shape. Measured:
    `Money.model_validate_json('{"…","exponent":2}')` is accepted.
    """
    with pytest.raises(ValidationError):
        Money(amountMinor="350000", currency=CurrencyCode.COP, exponent=2.0)

    Money.model_validate_json('{"amountMinor":"350000","currency":"COP","exponent":2}')


def test_money_forbids_unknown_fields() -> None:
    """A DIVERGENCE, not an agreement, and the safe one is still worth naming.

    Zod's default object mode STRIPS an unknown key and accepts the object:
    `Money.parse({..., "extra": 1})` succeeds on the TypeScript side and returns
    the three known fields. `z.toJSONSchema()` emits `additionalProperties:
    false` regardless, so `--strict-types` generates `extra="forbid"` and this
    side REJECTS the same payload.

    So the two sides disagree about `{"extra": 1}`, in the direction where
    Python is the stricter one -- an API that starts sending a field the workers
    have not regenerated for fails loudly here rather than being silently
    dropped. That is the outcome this repository wants, which is exactly why it
    needs writing down: it is easy to read this test as "both sides forbid it".
    The generated header enumerates it, because a header claiming to list the
    divergences must list the ones that landed well too.
    """
    with pytest.raises(ValidationError):
        Money.model_validate(
            {"amountMinor": "350000", "currency": "COP", "exponent": 0, "extra": 1}
        )


def test_money_currency_is_the_shared_enum_and_not_a_second_copy() -> None:
    """`$ref` survived, so there is ONE currency enum on this side.

    Emitted per-schema instead of through a registry, `Money.currency` inlines
    the enum and the generator writes a SECOND class -- `Currency` beside
    `CurrencyCode` -- for one contract. Two enums that must never disagree is the
    drift this boundary exists to prevent, and it is invisible from TypeScript.
    """
    assert Money.model_fields["currency"].annotation is CurrencyCode
    assert [name for name in _generated_enums() if name.startswith("Currency")] == ["CurrencyCode"]


def test_the_currency_enum_is_closed() -> None:
    assert set(CurrencyCode) == {
        CurrencyCode.COP,
        CurrencyCode.USD,
        CurrencyCode.EUR,
        CurrencyCode.MXN,
    }
    with pytest.raises(ValidationError):
        Money(amountMinor="1", currency="GBP", exponent=2)


def test_the_domain_error_codes_crossed_intact() -> None:
    assert DomainErrorCode("QUOTE_EXPIRED") is DomainErrorCode.QUOTE_EXPIRED
    assert len(DomainErrorCode) == 28


# ----------------------- the backslash-d divergence family --------------------


def test_the_source_scan_finds_the_patterns_it_claims_to_find() -> None:
    """Non-vacuity for the scan itself, before anything is built on it."""
    found = _source_patterns()

    assert "Money" in found
    assert found["Money"] == ["^(0|-?[1-9][0-9]*)$"]
    assert len(found) >= 12
    assert all(patterns for patterns in found.values())


def test_every_pattern_in_the_generated_source_was_actually_applied() -> None:
    r"""A constraint the generator wrote and pydantic silently dropped.

    THE FAILURE THIS EXISTS FOR, measured with `z.iso.datetime()` in the emitted
    set: the generated source says
    `Annotated[AwareDatetime, Field(pattern="^\d{4}-...")]`, pydantic cannot
    apply a string pattern to a datetime, and it discards it WITHOUT ERROR --
    `model_json_schema()` comes back with no `pattern` key at all. The file
    imports cleanly, `ruff`, `ruff format` and `mypy --strict` are all green, and
    every payload then raises an uncaught `TypeError`.

    Comparing the two views is what makes that visible: the source says a
    constraint is there, the round-tripped schema says it is not, and the gap
    between them is a constraint that is not being enforced.
    """
    dropped = {
        name: patterns
        for name, patterns in _source_patterns().items()
        if not _patterns(_generated_models()[name].model_json_schema())
    }

    assert dropped == {}, (
        "pydantic discarded a pattern the generator emitted, silently. The model still "
        f"imports and still typechecks, and it enforces nothing: {dropped}"
    )


def test_the_probe_table_covers_every_pattern_carrying_model() -> None:
    """Non-vacuity for the two tests below, and what must not silently shrink.

    Read from the GENERATED SOURCE, not from `model_json_schema()`. The
    round-tripped schema omits any pattern pydantic could not apply, so a guard
    built on it goes quiet on exactly the models that are broken -- which is the
    opposite of what a guard is for. See `_source_patterns`.
    """
    with_patterns = set(_source_patterns())

    assert with_patterns == set(NON_ASCII_DIGIT_PROBES), (
        "a model carrying a regex crossed the boundary with no non-ASCII-digit probe. "
        "Python's `\\d` matches any Unicode decimal digit and JavaScript's does not, so "
        "an untested pattern is a model that may be strictly more permissive than the "
        "Zod schema defining it -- see ADR-0027"
    )
    assert len(with_patterns) >= 12


@pytest.mark.parametrize("name", sorted(NON_ASCII_DIGIT_PROBES))
def test_no_generated_model_accepts_non_ascii_digits(name: str) -> None:
    r"""The behavioural half of the `\d` guard, per pattern-carrying model.

    Zod rejects every one of these inputs. If any is accepted here, the emitted
    pattern is spelling a digit class in a way that means something different in
    the two engines, and the Python side has become strictly more permissive than
    the TypeScript side that defines it.

    The ASCII twin is validated FIRST, and it is not decoration: without it a
    probe of the wrong SHAPE is rejected for a reason that has nothing to do with
    digits, and this test passes while proving nothing. That is not hypothetical
    -- it is what the first version of this file did, and a mutation found it.
    """
    model = _generated_models()[name]

    model.model_validate(ASCII_TWINS[name])

    with pytest.raises(ValidationError):
        model.model_validate(NON_ASCII_DIGIT_PROBES[name])


def test_no_emitted_pattern_spells_a_digit_class_as_backslash_d() -> None:
    r"""The static half, and the one that fires on a Zod BUILT-IN format.

    `z.e164()`, `z.iso.datetime()`, `z.iso.date()` and `z.iso.time()` all emit
    `\d` in their patterns and are library internals no edit in this repository
    can reach. ADR-0027 decided deliberately NOT to post-process them in the
    emitter -- rewriting a regex the TypeScript side believes it owns
    reintroduces the divergence one layer down while looking like a fix.

    So this fails when one arrives, rather than pretending it cannot. The fix is
    not to delete this assertion: it is to add a behavioural probe above for that
    format (MEASURED on zod 4.4.3, `z.e164()` accepts a phone number with
    Arabic-Indic digits here and Zod rejects it) and to record the decision.

    READS THE GENERATED SOURCE, and an earlier version of this test did not --
    it read `model_json_schema()`, which omits any pattern pydantic could not
    apply. Measured: with `z.iso.datetime()` emitted, that version passed against
    a model that raises on every payload, so it was blind to three of the four
    built-ins its own docstring names. The source literal survives regardless of
    whether pydantic could use it, which is precisely why it is the right thing
    to read.
    """
    offenders = {
        name: [p for p in patterns if re.search(r"\\d", p)]
        for name, patterns in _source_patterns().items()
        if any(re.search(r"\\d", p) for p in patterns)
    }

    assert offenders == {}, (
        f"these patterns mean different things in JavaScript and Python: {offenders}"
    )


def test_the_uuid_pattern_accepts_the_same_case_zod_accepts() -> None:
    """`brand.ts`'s `/i` regression, asserted where it was observable.

    `z.toJSONSchema()` drops regex flags silently, so an `/i` on the TypeScript
    side produces a Python model that rejects an ID TypeScript accepts. The case
    is spelled into the character classes there; this is what proves it arrived.
    """
    assert QuoteId(VALID_UUID.upper()).root == VALID_UUID.upper()
    assert QuoteId(VALID_UUID).root == VALID_UUID

    for bad in ["not-a-uuid", "", "0190a1b2-c3d4-0e5f-8a9b-0c1d2e3f4051", f"x{VALID_UUID}"]:
        with pytest.raises(ValidationError):
            QuoteId(bad)


def test_branding_did_not_cross_and_the_file_says_so() -> None:
    """ADR-0018 stops here, and a reader of the generated file has to be told.

    `QuoteId` and `OrderId` are the same constrained `str` on this side -- the
    assertion below is not a bug report, it is the documented limit. What must
    not happen is someone assuming the TypeScript guarantee holds here, so the
    generated file carries the warning in its header and this asserts it is
    still there.
    """
    assert QuoteId(VALID_UUID).root == OrderId(VALID_UUID).root

    header = GENERATED.read_text(encoding="utf-8")
    assert "BRANDING" in header
    assert "DO NOT EDIT" in header


def test_the_generated_module_imports_no_any() -> None:
    """The root schema declares `type: object` specifically so this holds.

    Without it the generator writes `class MetrikaContracts(RootModel[Any])` and
    imports `Any` into the one module that is already exempt from
    `disallow_any_explicit`. Two reasons to widen an exemption is one too many.
    """
    assert "Any" not in GENERATED.read_text(encoding="utf-8")


# -------------------------- the exemptions, guarded ---------------------------
#
# Both entries below exist because a GENERATED file cannot carry a hand-written
# suppression: it is byte-diffed in CI, so nothing may be added to it by hand.
# Both are therefore config-level exemptions, which is the shape that widens
# under time pressure. These tests are what stops that being quiet.


def _workspace_table(*path: str) -> dict[str, object]:
    with (WORKERS_ROOT / "pyproject.toml").open("rb") as handle:
        node: object = tomllib.load(handle)

    for key in path:
        assert isinstance(node, dict), f"apps/workers/pyproject.toml has no [{'.'.join(path)}]"
        node = node[key]

    assert isinstance(node, dict)
    return node


def test_only_the_generated_module_is_exempt_from_disallow_any_explicit() -> None:
    """MEASURED: adding `metrika_core.*` here turns this test red.

    `disallow_any_explicit` fires on the class line of every pydantic model --
    `class S(BaseModel): x: int` reproduces it -- from the `__init__` mypy
    synthesises out of pydantic's `dataclass_transform`. `plugins =
    ["pydantic.mypy"]` does not fix it. `metrika_core`, `geometry` and `slicer`
    are where humans write code and an explicit `Any` there is a real smell, so
    the flag stays on for them and this list stays exactly one module long.
    """
    # `.get`, not `[...]`: DELETING the overrides block is as much a change to
    # this exemption as widening it, and a bare `KeyError` would fail with a
    # traceback instead of the message written for whoever did it.
    overrides = _workspace_table("tool", "mypy").get("overrides", [])
    assert isinstance(overrides, list), (
        "apps/workers/pyproject.toml declares no [[tool.mypy.overrides]] at all. The "
        "generated contracts module needs exactly one; see the comment above "
        "`disallow_any_explicit`"
    )

    relaxed = [
        entry
        for entry in overrides
        if isinstance(entry, dict) and entry.get("disallow_any_explicit") is False
    ]

    assert len(relaxed) == 1, (
        "expected exactly one override relaxing `disallow_any_explicit`, for "
        f"{MODULE}, and found {len(relaxed)}: {overrides}"
    )
    assert relaxed[0]["module"] == [MODULE], (
        "the explicit-Any exemption has been widened beyond the generated module; a "
        "hand-written model can carry a justified inline explicit-any suppression, and must"
    )


def test_only_the_generated_module_waives_the_wire_naming_rule() -> None:
    """N815 is off for the generated file and for nothing else.

    `amountMinor` is the WIRE name -- renaming it would break the contract this
    file exists to carry. Every other module in the workspace is hand-written
    Python and has no excuse for a camelCase attribute.
    """
    per_file = _workspace_table("tool", "ruff", "lint", "per-file-ignores")
    waivers = {pattern: rules for pattern, rules in per_file.items() if "N815" in str(rules)}

    assert waivers == {"packages/metrika_core/src/metrika_core/contracts/**": ["N815"]}, (
        f"N815 is waived somewhere it should not be, or in company: {waivers}"
    )


def test_the_generated_file_is_where_the_configuration_says_it_is() -> None:
    """Both exemptions above name a path. This is what keeps them pointing at it."""
    expected = WORKERS_ROOT / "packages/metrika_core/src/metrika_core/contracts/__init__.py"

    assert expected == GENERATED, f"the generated module moved to {GENERATED}"
