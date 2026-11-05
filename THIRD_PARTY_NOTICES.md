# Third-party notices

SATURN bundles the following third-party components. Full licence texts are in `licenses/`
and are installed alongside the game (`resources/licenses`).

| Component | Use in SATURN | Licence |
|---|---|---|
| **Qwen3-4B-Instruct-2507** (Alibaba Cloud / Qwen team), GGUF Q4_K_M quantisation published by Unsloth | Default local language model (Game Master) | Apache-2.0 (`licenses/Qwen3-LICENSE.txt`) |
| **Qwen3.5-2B** (Qwen team), GGUF Q4_K_M quantisation published by Unsloth | Optional "light" model profile | Apache-2.0 |
| **llama.cpp** (ggml-org) | Local inference runtime (prebuilt CPU/Vulkan backends) | MIT |
| **node-llama-cpp** | Node bindings for llama.cpp, JSON-schema grammar decoding | MIT (`licenses/node-llama-cpp-LICENSE.txt`) |
| **better-sqlite3** / **SQLite** | Save files and world database | MIT / public domain |
| **Ajv** | JSON Schema validation of AI output | MIT (`licenses/ajv-LICENSE.txt`) |
| **Electron** / **Chromium** | Desktop application shell | MIT / BSD-style (`LICENSES.chromium.html` shipped by Electron) |

All artwork in SATURN (location illustrations, portraits, logo) is generated procedurally by
`src/ui/art.js`, written for this project. No third-party images, fonts or audio are bundled;
the interface uses the operating system's installed fonts.

The world, characters and text of *The Saltwind Reach* were written for this project.

The Apache-2.0 model weights are redistributed unmodified (quantised GGUF form as published),
with this notice and the licence text, as the licence requires.
