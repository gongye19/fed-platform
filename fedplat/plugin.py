from typing import Any


class Plugin:
    """Default plugin: store only, never merge. Override to add an algorithm."""

    name = "store_only"

    def validate_item(self, item: Any) -> None:
        return None

    def aggregate(self, items: list[dict], prev: dict | None) -> dict:
        return prev or {}

    def render_digest(self, state: dict, site_id: str) -> dict:
        return {"items": [], "ops": []}


_PLUGINS: dict[str, type[Plugin]] = {Plugin.name: Plugin}


def register_plugin(cls: type[Plugin]) -> type[Plugin]:
    _PLUGINS[cls.name] = cls
    return cls


def get_plugin(name: str) -> Plugin:
    try:
        return _PLUGINS[name]()
    except KeyError as e:
        raise KeyError(name) from e
