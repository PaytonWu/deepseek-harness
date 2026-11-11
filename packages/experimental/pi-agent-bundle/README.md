---
description: "Delegate continuable coding tasks to pi child agents, for users choosing an external pi runtime."
kind: "package-bundle"
---

# @deepseek-ai/dsh-pi-agent-bundle

English | [中文](README.zh.md)

## Summary

Enable the model-facing `pi_agent` tool that runs delegated coding tasks as continuable pi coding-agent children in their own sessions. Children accept follow-up messages, can be interrupted, and resume after a Host restart. It ships switched off in Web and Desktop; select it in Plugins to enable it. The host machine needs `pi` on PATH.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

In Web or Desktop, open Plugins and enable **PI agent** in Official. Switching it off removes the profile layer; the package stays installed. The tool needs `pi` resolvable from the Host process environment and fails loudly with install guidance otherwise.

A switched-on layer adds the `pi_agent` tool to every Agent; switching it off removes the tool in the running Host, and live Agents see the change on their next request.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) contributes the `optional-pi-agent` row on the Host. Later root patches can disable that row; an override alone does not select the bundle. The [profile composer](../../boot/app-boot/README.md) owns patch ordering and errors.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Capability implementation](../pi-agent/README.md)

## Model Experience

Indirectly, through the pi agent capability: the bundle contributes only the profile layer, and the [pi agent implementation](../pi-agent/README.md#model-experience) owns the tool schema and usage guidance.

#### KV Cache effect

The layer contributes no model request content by itself; enabling or disabling it adds or removes a tool declaration, which is a request-prefix change owned by the capability package.

## Known Limitations and Deferred Work

- **pi must be on PATH** — the bundle neither downloads nor bundles a pi runtime.
- **Experimental** — the capability is under evaluation and may change or be withdrawn; see the [experimental group](../README.md#status).
### Dev Note
<details>
<summary>Maintainer context — click to expand</summary>

None.

</details>
