# claude-plugins

A Claude Code plugin marketplace.

## Plugins

| Plugin | Description |
|---|---|
| [premise-check](plugins/premise-check) | A Haiku side agent watches the session for claims about libraries, frameworks and versions made from stale training data, and gets them checked. |

## Install

On Claude Code 2.1.275 or later, add the marketplace and install a plugin in one step:

```
/plugin install premise-check --marketplace anthony-recharge/claude-plugins
```

On earlier versions, add the marketplace first:

```
/plugin marketplace add anthony-recharge/claude-plugins
```

Install a plugin from it:

```
/plugin install premise-check@anthony-plugins
```

To get new versions, update the marketplace:

```
/plugin marketplace update anthony-plugins
```

To use a local clone instead of GitHub, add the clone directory:

```
/plugin marketplace add /path/to/claude-plugins
```
