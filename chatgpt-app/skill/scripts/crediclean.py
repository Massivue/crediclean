#!/usr/bin/env python3
"""
CrediClean: inspect and remove C2PA Content Credentials from an image.

Runs inside ChatGPT's own sandbox, on a file already sitting there. Nothing is
uploaded anywhere and no network is used, because no network is needed.

WHAT IT DOES
  Drops the container block that holds the credentials and copies every other
  byte of the file across unchanged. The compressed picture data is never
  touched, so the result is pixel-for-pixel identical to the original and
  nothing is re-compressed.

WHAT IT DOES NOT DO, AND WILL NOT CLAIM
  It removes metadata. It does NOT remove invisible watermarks such as
  SynthID, which live in the pixels themselves and survive this entirely. It
  does not make an image untraceable, human-made, or undetectable, and must
  never be described as doing so.

THIS IS A PORT, NOT AN ORIGINAL
  The logic mirrors the JavaScript engine in src/formats/ and
  src/processing/credential-processor.js, which is independently verified
  against real C2PA-signed files. chatgpt-app/tests/unit/skill_parity.test.js
  runs both over the same inputs and fails if a single output byte differs,
  which is what keeps this honest as the other one changes.

Usage:
    python3 crediclean.py inspect <image>
    python3 crediclean.py remove  <image> [output] [--keep-xmp]
"""

import json
import sys

# ---------------------------------------------------------------------------
# Format detection, from the bytes themselves
# ---------------------------------------------------------------------------

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def detect_format(data: bytes) -> str:
    """Identify the container. Never trust a file extension for this."""
    if data.startswith(PNG_SIGNATURE):
        return "png"
    if len(data) >= 3 and data[0] == 0xFF and data[1] == 0xD8 and data[2] == 0xFF:
        return "jpeg"
    if len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[0:4] == b"GIF8":
        return "gif"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        brand = data[8:12].decode("ascii", "replace")
        if brand in ("avif", "avis"):
            return "avif"
        if brand in ("heic", "heix", "hevc", "mif1"):
            return "heic"
    return "unknown"


FORMAT_LABELS = {
    "png": "PNG",
    "jpeg": "JPEG",
    "webp": "WebP",
    "gif": "GIF",
    "avif": "AVIF",
    "heic": "HEIC",
    "unknown": "unrecognised format",
}

SUPPORTED = ("png", "jpeg", "webp")

# A manifest store points at itself from XMP with this key.
XMP_PROVENANCE_HINT = b"dcterms:provenance"

# ---------------------------------------------------------------------------
# JUMBF: just enough of the box tree to recognise a C2PA manifest store
# ---------------------------------------------------------------------------

MAX_BOXES = 20000
MAX_DEPTH = 8


def _parse_jumbf(data: bytes, start: int, end: int, depth: int, state: dict) -> list:
    """
    Walk a JUMBF (ISO/IEC 19566-5) box tree.

    Each box is: LBox (4, big-endian) | TBox (4 ASCII) | payload, where LBox
    counts the whole box. LBox 1 means a 64-bit length follows; LBox 0 means
    the box runs to the end of its parent.
    """
    boxes = []
    offset = start
    while offset + 8 <= end:
        if state["count"] >= MAX_BOXES or depth > MAX_DEPTH:
            break
        state["count"] += 1

        length = int.from_bytes(data[offset:offset + 4], "big")
        box_type = data[offset + 4:offset + 8].decode("ascii", "replace")
        header = 8

        if length == 1:
            if offset + 16 > end:
                break
            high = int.from_bytes(data[offset + 8:offset + 12], "big")
            low = int.from_bytes(data[offset + 12:offset + 16], "big")
            if high != 0:
                break
            length = low
            header = 16
        elif length == 0:
            length = end - offset

        if length < header or offset + length > end:
            break

        content_start = offset + header
        content_end = offset + length
        box = {"type": box_type, "label": None, "uuid_prefix": None, "children": []}

        if box_type == "jumd":
            # Description box: UUID (16) | toggles (1) | label, NUL-terminated
            if content_end - content_start >= 17:
                box["uuid_prefix"] = data[content_start:content_start + 4].decode("ascii", "replace")
                toggles = data[content_start + 16]
                if toggles & 0x02:
                    cursor = content_start + 17
                    end_of_label = data.find(b"\x00", cursor, content_end)
                    if end_of_label > cursor:
                        box["label"] = data[cursor:end_of_label].decode("utf-8", "replace")
        elif box_type == "jumb":
            box["children"] = _parse_jumbf(data, content_start, content_end, depth + 1, state)
            # A superbox takes its identity from its description box.
            for child in box["children"]:
                if child["type"] == "jumd":
                    box["label"] = child["label"]
                    box["uuid_prefix"] = child["uuid_prefix"]
                    break

        boxes.append(box)
        offset += length
    return boxes


def parse_jumbf(data: bytes, start: int = 0, end: int = None) -> list:
    if end is None:
        end = len(data)
    return _parse_jumbf(data, start, end, 0, {"count": 0})


def looks_like_c2pa_store(boxes: list) -> bool:
    """A manifest store is a 'jumb' labelled c2pa, or with the c2pa UUID."""
    return any(
        box["type"] == "jumb" and (box["label"] == "c2pa" or box["uuid_prefix"] == "c2pa")
        for box in boxes
    )

# ---------------------------------------------------------------------------
# PNG
# ---------------------------------------------------------------------------

PNG_C2PA_CHUNK = "caBX"
XMP_ITXT_KEYWORD = b"XML:com.adobe.xmp"
MAX_CHUNKS = 10000


def parse_png_chunks(data: bytes):
    """Walk the chunk list. Each chunk: length (4) | type (4) | data | CRC (4)."""
    chunks = []
    if not data.startswith(PNG_SIGNATURE):
        return None, "Not a PNG file (bad signature)."

    offset = 8
    while offset + 8 <= len(data):
        if len(chunks) >= MAX_CHUNKS:
            return None, "PNG has an implausible number of chunks."
        data_length = int.from_bytes(data[offset:offset + 4], "big")
        chunk_type = data[offset + 4:offset + 8].decode("ascii", "replace")
        total = 12 + data_length
        if data_length > 0x7FFFFFFF or offset + total > len(data):
            break  # truncated; stop rather than read past the end
        chunks.append(
            {
                "type": chunk_type,
                "offset": offset,
                "data_offset": offset + 8,
                "data_length": data_length,
                "total_length": total,
            }
        )
        offset += total
        if chunk_type == "IEND":
            break

    if not chunks:
        return None, "PNG contains no readable chunks."
    return chunks, None


def png_dimensions(data: bytes, chunks: list):
    for chunk in chunks:
        if chunk["type"] == "IHDR" and chunk["data_length"] >= 8:
            base = chunk["data_offset"]
            return (
                int.from_bytes(data[base:base + 4], "big"),
                int.from_bytes(data[base + 4:base + 8], "big"),
            )
    return None


def _itxt_keyword(data: bytes, chunk: dict):
    start = chunk["data_offset"]
    end = start + chunk["data_length"]
    stop = data.find(b"\x00", start, end)
    if stop < 0:
        return None
    return data[start:stop]


def _has_provenance(data: bytes, offset: int, length: int) -> bool:
    window = data[offset:offset + min(length, 65536)]
    return XMP_PROVENANCE_HINT in window


def strip_png(data: bytes, remove_xmp: bool):
    chunks, error = parse_png_chunks(data)
    if error:
        raise ValueError(error)

    kept, removed = [], []
    for chunk in chunks:
        if chunk["type"] == PNG_C2PA_CHUNK:
            removed.append({"label": "C2PA manifest store", "bytes": chunk["total_length"]})
            continue
        if remove_xmp and chunk["type"] == "iTXt":
            if _itxt_keyword(data, chunk) == XMP_ITXT_KEYWORD and _has_provenance(
                data, chunk["data_offset"], chunk["data_length"]
            ):
                removed.append(
                    {
                        "label": "XMP packet containing a provenance reference",
                        "bytes": chunk["total_length"],
                    }
                )
                continue
        kept.append(chunk)

    out = bytearray(PNG_SIGNATURE)
    for chunk in kept:
        out += data[chunk["offset"]:chunk["offset"] + chunk["total_length"]]
    return bytes(out), removed

# ---------------------------------------------------------------------------
# JPEG
# ---------------------------------------------------------------------------

MARKER_SOI, MARKER_SOS, MARKER_EOI = 0xD8, 0xDA, 0xD9
MARKER_APP1, MARKER_APP11 = 0xE1, 0xEB
STANDALONE = {0x01, MARKER_SOI, MARKER_EOI}
APP11_HEADER_LENGTH = 16  # "JP" + instance(2) + sequence(4) + LBox(4) + TBox(4)
XMP_NAMESPACE = b"http://ns.adobe.com/xap/1.0/"
MAX_SEGMENTS = 10000


def parse_jpeg_segments(data: bytes):
    if len(data) < 4 or data[0] != 0xFF or data[1] != 0xD8:
        return None, None, "Not a JPEG file (missing start-of-image marker)."

    segments = []
    offset = 2
    scan_offset = None

    while offset + 1 < len(data):
        if len(segments) >= MAX_SEGMENTS:
            return None, None, "JPEG has an implausible number of segments."
        if data[offset] != 0xFF:
            return None, None, "JPEG structure is malformed (expected a marker)."

        # Repeated 0xFF bytes are legal fill before a marker.
        marker_pos = offset
        while marker_pos + 1 < len(data) and data[marker_pos + 1] == 0xFF:
            marker_pos += 1
        marker = data[marker_pos + 1]

        if marker == MARKER_SOS:
            scan_offset = marker_pos
            break
        if marker in STANDALONE or 0xD0 <= marker <= 0xD7:
            offset = marker_pos + 2
            continue

        if marker_pos + 4 > len(data):
            return None, None, "JPEG is truncated inside a segment header."
        length = int.from_bytes(data[marker_pos + 2:marker_pos + 4], "big")
        if length < 2 or marker_pos + 2 + length > len(data):
            return None, None, "JPEG is truncated or has a bad segment length."

        segments.append(
            {
                "marker": marker,
                "offset": marker_pos,
                "total_length": 2 + length,
                "payload_offset": marker_pos + 4,
                "payload_length": length - 2,
            }
        )
        offset = marker_pos + 2 + length

    if scan_offset is None:
        return None, None, "JPEG contains no image scan data."
    return segments, scan_offset, None


def read_app11_header(data: bytes, segment: dict):
    """Layout: "JP" | instance (2) | sequence (4) | LBox (4) | TBox (4)."""
    if segment["marker"] != MARKER_APP11 or segment["payload_length"] < APP11_HEADER_LENGTH:
        return None
    base = segment["payload_offset"]
    if data[base:base + 2] != b"JP":
        return None
    return {
        "instance": int.from_bytes(data[base + 2:base + 4], "big"),
        "sequence": int.from_bytes(data[base + 4:base + 8], "big"),
        "lbox": int.from_bytes(data[base + 8:base + 12], "big"),
        "tbox": data[base + 12:base + 16].decode("ascii", "replace"),
        "box_data_offset": base + APP11_HEADER_LENGTH,
        "box_data_length": segment["payload_length"] - APP11_HEADER_LENGTH,
    }


def group_app11_segments(data: bytes, segments: list) -> list:
    """
    Group APP11 segments by box instance and work out which hold C2PA.

    A manifest store larger than one 64 KiB segment is split across several,
    each repeating the 16-byte header. Reading only the first would see a
    fragment of the box tree and could miss the store entirely, so the group
    is reassembled before it is judged.
    """
    groups = {}
    for segment in segments:
        header = read_app11_header(data, segment)
        if not header or header["tbox"] != "jumb":
            continue
        group = groups.setdefault(
            header["instance"], {"segments": [], "total_bytes": 0, "is_c2pa": False}
        )
        group["segments"].append(segment)
        group["total_bytes"] += segment["total_length"]

    for group in groups.values():
        ordered = sorted(
            group["segments"],
            key=lambda s: (read_app11_header(data, s)["sequence"], s["offset"]),
        )
        first = read_app11_header(data, ordered[0])
        # LBox and TBox from the first segment, then every segment's box data.
        box = bytearray(data[first["box_data_offset"] - 8:first["box_data_offset"]])
        for segment in ordered:
            header = read_app11_header(data, segment)
            box += data[
                header["box_data_offset"]:header["box_data_offset"] + header["box_data_length"]
            ]
        group["is_c2pa"] = looks_like_c2pa_store(parse_jumbf(bytes(box)))

    return list(groups.values())


def is_xmp_segment(data: bytes, segment: dict) -> bool:
    if segment["marker"] != MARKER_APP1 or segment["payload_length"] < len(XMP_NAMESPACE) + 1:
        return False
    base = segment["payload_offset"]
    return data[base:base + len(XMP_NAMESPACE)] == XMP_NAMESPACE


def jpeg_dimensions(data: bytes, segments: list):
    for segment in segments:
        # SOF0..SOF15, excluding the DHT/JPG/DAC markers in that range.
        if 0xC0 <= segment["marker"] <= 0xCF and segment["marker"] not in (0xC4, 0xC8, 0xCC):
            if segment["payload_length"] >= 5:
                base = segment["payload_offset"]
                return (
                    int.from_bytes(data[base + 3:base + 5], "big"),
                    int.from_bytes(data[base + 1:base + 3], "big"),
                )
    return None


def strip_jpeg(data: bytes, remove_xmp: bool):
    segments, scan_offset, error = parse_jpeg_segments(data)
    if error:
        raise ValueError(error)

    doomed, removed = set(), []
    for group in group_app11_segments(data, segments):
        if not group["is_c2pa"]:
            continue
        # Every segment of the box instance goes, not just the first.
        for segment in group["segments"]:
            doomed.add(segment["offset"])
        removed.append({"label": "C2PA manifest store", "bytes": group["total_bytes"]})

    kept = []
    for segment in segments:
        if segment["offset"] in doomed:
            continue
        if remove_xmp and is_xmp_segment(data, segment):
            if _has_provenance(data, segment["payload_offset"], segment["payload_length"]):
                removed.append(
                    {
                        "label": "XMP packet containing a provenance reference",
                        "bytes": segment["total_length"],
                    }
                )
                continue
        kept.append(segment)

    out = bytearray(b"\xff\xd8")
    for segment in kept:
        out += data[segment["offset"]:segment["offset"] + segment["total_length"]]
    out += data[scan_offset:]
    return bytes(out), removed

# ---------------------------------------------------------------------------
# WebP
# ---------------------------------------------------------------------------

WEBP_C2PA_FOURCC = "C2PA"
WEBP_XMP_FOURCC = "XMP "
RIFF_HEADER_LENGTH = 12


def parse_webp_chunks(data: bytes):
    """RIFF | size (4, little-endian) | WEBP | chunks, each padded to even."""
    if len(data) < RIFF_HEADER_LENGTH:
        return None, "File is too short to be a WebP."
    if data[0:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None, "Not a WebP file (bad RIFF header)."

    chunks = []
    offset = RIFF_HEADER_LENGTH
    while offset + 8 <= len(data):
        if len(chunks) >= MAX_CHUNKS:
            return None, "WebP has an implausible number of chunks."
        fourcc = data[offset:offset + 4].decode("ascii", "replace")
        data_length = int.from_bytes(data[offset + 4:offset + 8], "little")
        padded = data_length + (data_length & 1)
        total = 8 + padded

        if data_length > 0x7FFFFFFF or offset + total > len(data):
            # Tolerate a final chunk whose pad byte was never written.
            if offset + 8 + data_length <= len(data):
                chunks.append(
                    {
                        "fourcc": fourcc,
                        "offset": offset,
                        "data_offset": offset + 8,
                        "data_length": data_length,
                        "total_length": 8 + data_length,
                    }
                )
            break

        chunks.append(
            {
                "fourcc": fourcc,
                "offset": offset,
                "data_offset": offset + 8,
                "data_length": data_length,
                "total_length": total,
            }
        )
        offset += total

    if not chunks:
        return None, "WebP contains no readable chunks."
    return chunks, None


def webp_dimensions(data: bytes, chunks: list):
    for chunk in chunks:
        if chunk["fourcc"] == "VP8X" and chunk["data_length"] >= 10:
            base = chunk["data_offset"] + 4
            width = 1 + int.from_bytes(data[base:base + 3], "little")
            height = 1 + int.from_bytes(data[base + 3:base + 6], "little")
            return width, height
    for chunk in chunks:
        if chunk["fourcc"] == "VP8L" and chunk["data_length"] >= 5:
            base = chunk["data_offset"] + 1
            bits = int.from_bytes(data[base:base + 4], "little")
            return 1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF)
        if chunk["fourcc"] == "VP8 " and chunk["data_length"] >= 10:
            base = chunk["data_offset"] + 6
            return (
                int.from_bytes(data[base:base + 2], "little") & 0x3FFF,
                int.from_bytes(data[base + 2:base + 4], "little") & 0x3FFF,
            )
    return None


def strip_webp(data: bytes, remove_xmp: bool):
    chunks, error = parse_webp_chunks(data)
    if error:
        raise ValueError(error)

    kept, removed = [], []
    for chunk in chunks:
        if chunk["fourcc"] == WEBP_C2PA_FOURCC:
            removed.append({"label": "C2PA manifest store", "bytes": chunk["total_length"]})
            continue
        if (
            remove_xmp
            and chunk["fourcc"] == WEBP_XMP_FOURCC
            and _has_provenance(data, chunk["data_offset"], chunk["data_length"])
        ):
            removed.append(
                {
                    "label": "XMP packet containing a provenance reference",
                    "bytes": chunk["total_length"],
                }
            )
            continue
        kept.append(chunk)

    payload = sum(chunk["total_length"] for chunk in kept)
    out = bytearray(data[0:RIFF_HEADER_LENGTH])
    # The RIFF size field counts everything after itself: "WEBP" plus chunks.
    out[4:8] = (4 + payload).to_bytes(4, "little")
    for chunk in kept:
        out += data[chunk["offset"]:chunk["offset"] + chunk["total_length"]]
    return bytes(out), removed

# ---------------------------------------------------------------------------
# Inspection
# ---------------------------------------------------------------------------


def inspect(data: bytes) -> dict:
    """Report what provenance data this file carries. Changes nothing."""
    image_format = detect_format(data)
    report = {
        "format": image_format,
        "format_label": FORMAT_LABELS.get(image_format, FORMAT_LABELS["unknown"]),
        "supported": image_format in SUPPORTED,
        "byte_length": len(data),
        "dimensions": None,
        "credentials_found": False,
        "locations": [],
        "error": None,
    }

    if not report["supported"]:
        report["error"] = f"{report['format_label']} files are not supported."
        return report

    try:
        if image_format == "png":
            chunks, error = parse_png_chunks(data)
            if error:
                report["error"] = error
                return report
            size = png_dimensions(data, chunks)
            for chunk in chunks:
                if chunk["type"] == PNG_C2PA_CHUNK:
                    report["credentials_found"] = True
                    report["locations"].append("PNG caBX chunk")
        elif image_format == "jpeg":
            segments, _scan, error = parse_jpeg_segments(data)
            if error:
                report["error"] = error
                return report
            size = jpeg_dimensions(data, segments)
            for group in group_app11_segments(data, segments):
                if group["is_c2pa"]:
                    report["credentials_found"] = True
                    count = len(group["segments"])
                    report["locations"].append(
                        "JPEG APP11 segment" if count == 1
                        else f"{count} contiguous JPEG APP11 segments"
                    )
        else:
            chunks, error = parse_webp_chunks(data)
            if error:
                report["error"] = error
                return report
            size = webp_dimensions(data, chunks)
            for chunk in chunks:
                if chunk["fourcc"] == WEBP_C2PA_FOURCC:
                    report["credentials_found"] = True
                    report["locations"].append("WebP C2PA chunk")
    except ValueError as error:
        report["error"] = str(error)
        return report

    if size:
        report["dimensions"] = {"width": size[0], "height": size[1]}
    return report

# ---------------------------------------------------------------------------
# Verification: the basis for claiming removal worked
# ---------------------------------------------------------------------------


def _pixel_data(data: bytes, image_format: str) -> bytes:
    """The compressed picture bytes, with all metadata excluded."""
    if image_format == "png":
        chunks, error = parse_png_chunks(data)
        if error:
            return b""
        return b"".join(
            data[c["data_offset"]:c["data_offset"] + c["data_length"]]
            for c in chunks
            if c["type"] == "IDAT"
        )
    if image_format == "jpeg":
        _segments, scan_offset, error = parse_jpeg_segments(data)
        if error:
            return b""
        return data[scan_offset:]
    chunks, error = parse_webp_chunks(data)
    if error:
        return b""
    pixel_chunks = {"VP8 ", "VP8L", "ALPH", "ANMF"}
    return b"".join(
        data[c["data_offset"]:c["data_offset"] + c["data_length"]]
        for c in chunks
        if c["fourcc"] in pixel_chunks
    )


def verify(original: bytes, output: bytes, expected_format: str) -> dict:
    """
    Check the result from scratch, rather than trusting the code that made it.

    If any of these fail the output is thrown away and the user is told nothing
    was saved. A quiet near-miss would be worse than a loud failure.
    """
    checks = []

    actual_format = detect_format(output)
    checks.append(
        {
            "name": "still a valid image of the same format",
            "passed": actual_format == expected_format,
            "detail": f"{expected_format} -> {actual_format}",
        }
    )

    after = inspect(output)
    checks.append(
        {
            "name": "no credentials remain",
            "passed": not after["credentials_found"],
            "detail": ", ".join(after["locations"]) or "none found",
        }
    )

    before = inspect(original)
    same_size = (
        before["dimensions"] is not None
        and before["dimensions"] == after["dimensions"]
    )
    checks.append(
        {
            "name": "dimensions unchanged",
            "passed": same_size,
            "detail": f"{before['dimensions']} -> {after['dimensions']}",
        }
    )

    a = _pixel_data(original, expected_format)
    b = _pixel_data(output, expected_format)
    identical = bool(a) and a == b
    checks.append(
        {
            "name": "picture data byte-for-byte identical",
            "passed": identical,
            "detail": f"{len(a)} bytes compared" if identical else "the picture data changed",
        }
    )

    return {"ok": all(check["passed"] for check in checks), "checks": checks}

# ---------------------------------------------------------------------------
# The one honest sentence about limits, repeated wherever a result is reported
# ---------------------------------------------------------------------------

LIMITS_NOTE = (
    "The picture itself is unchanged, pixel for pixel. Invisible watermarks "
    "inside the picture, such as SynthID, are NOT affected and are NOT removed. "
    "This does not make the image untraceable."
)


def remove(data: bytes, remove_xmp: bool = True) -> dict:
    """Remove the credentials, verify the result, and refuse to return a bad one."""
    report = inspect(data)
    # Order matters: an unsupported format also sets `error`, so asking about
    # support first is what keeps "we cannot open GIFs" from being reported as
    # "this file is damaged". The JavaScript engine checks in this same order.
    if not report["supported"]:
        return {
            "ok": False,
            "reason": "unsupported-format",
            "message": f"{report['format_label']} files are not supported.",
            "report": report,
        }
    if report["error"]:
        return {"ok": False, "reason": "unreadable", "message": report["error"], "report": report}
    if not report["credentials_found"]:
        return {
            "ok": False,
            "reason": "nothing-to-remove",
            "message": "No supported credentials were found, so there is nothing to remove.",
            "report": report,
        }

    strip = {"png": strip_png, "jpeg": strip_jpeg, "webp": strip_webp}[report["format"]]
    try:
        output, removed = strip(data, remove_xmp)
    except ValueError as error:
        return {"ok": False, "reason": "unreadable", "message": str(error), "report": report}

    verification = verify(data, output, report["format"])
    if not verification["ok"]:
        failed = [check["name"] for check in verification["checks"] if not check["passed"]]
        return {
            "ok": False,
            "reason": "verification-failed",
            "message": (
                "The result failed our own checks, so nothing was saved and the original "
                f"is untouched. Failed: {', '.join(failed)}."
            ),
            "verification": verification,
            "report": report,
        }

    return {
        "ok": True,
        "output": output,
        "removed": removed,
        "bytes_removed": len(data) - len(output),
        "verification": verification,
        "report": report,
        "note": LIMITS_NOTE,
    }

# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------


def _processed_name(path: str) -> str:
    if "." in path.rsplit("/", 1)[-1]:
        stem, _dot, extension = path.rpartition(".")
        return f"{stem}-processed.{extension}"
    return f"{path}-processed"


def main(argv: list) -> int:
    if len(argv) < 3 or argv[1] not in ("inspect", "remove"):
        print(__doc__.strip())
        return 2

    command, path = argv[1], argv[2]
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError as error:
        print(json.dumps({"ok": False, "message": f"Could not read the image: {error}"}))
        return 1

    if command == "inspect":
        report = inspect(data)
        print(
            json.dumps(
                {
                    "ok": report["error"] is None,
                    "format": report["format_label"],
                    "dimensions": report["dimensions"],
                    "credentials_found": report["credentials_found"],
                    "locations": report["locations"],
                    "error": report["error"],
                    "note": LIMITS_NOTE,
                },
                indent=2,
            )
        )
        return 0

    rest = argv[3:]
    remove_xmp = "--keep-xmp" not in rest
    targets = [value for value in rest if not value.startswith("--")]
    out_path = targets[0] if targets else _processed_name(path)

    result = remove(data, remove_xmp=remove_xmp)
    if not result["ok"]:
        print(
            json.dumps(
                {"ok": False, "reason": result["reason"], "message": result["message"]}, indent=2
            )
        )
        return 1

    with open(out_path, "wb") as handle:
        handle.write(result["output"])

    print(
        json.dumps(
            {
                "ok": True,
                "saved_to": out_path,
                "format": result["report"]["format_label"],
                "dimensions": result["report"]["dimensions"],
                "removed": [item["label"] for item in result["removed"]],
                "bytes_removed": result["bytes_removed"],
                "verified": [check["name"] for check in result["verification"]["checks"]],
                "note": result["note"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
