from __future__ import annotations

import json
import sys
from pathlib import Path

from fedplat.federation_algorithm import AlgorithmInput, AlgorithmResult, load_algorithm


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: python -m fedplat.algorithm_host REQUEST RESULT")
    request_path = Path(sys.argv[1]).resolve()
    result_path = Path(sys.argv[2]).resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    output_dir = Path(request["output_dir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=False)
    plugin = load_algorithm(request["plugin_id"], request["plugin_version"])
    inputs = [
        AlgorithmInput(
            submission_id=item["submission_id"],
            site_id=item["site_id"],
            digest=item["digest"],
            type_name=item["type_name"],
            format_version=int(item["format_version"]),
            media_type=item["media_type"],
            metadata=item["metadata"],
            content=Path(item["content_path"]).read_bytes(),
        )
        for item in request["inputs"]
    ]
    result = plugin.run(
        inputs=inputs,
        config=request["config"],
        state=request["state"],
        round_id=request["round_id"],
    )
    if not isinstance(result, AlgorithmResult):
        raise TypeError("federation algorithm returned an invalid result")
    outputs = []
    for index, item in enumerate(result.outputs):
        content_path = output_dir / str(index)
        content_path.write_bytes(item.content)
        outputs.append(
            {
                "type_name": item.type_name,
                "format_version": item.format_version,
                "media_type": item.media_type,
                "metadata": item.metadata,
                "content_path": str(content_path),
            }
        )
    result_path.write_text(
        json.dumps(
            {
                "outputs": outputs,
                "new_state": result.new_state,
                "evidence": result.evidence,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
