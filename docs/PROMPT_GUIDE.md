# Prompt writing guidelines

This guide explains how to define **system prompts** and **tool descriptions** so they work well with the agent.

---

## 1. System prompt

You pass a system prompt when creating the agent (e.g. `createDeepAgent({ systemPrompt: "..." })`). Your text is merged with the library’s base instructions (tool access); your content comes first, then the base prompt.

### What to put in it

- **Role and behavior**: Who the agent is, tone, and any domain rules.
- **Scope**: What it should and shouldn’t do.
- Keep it focused; the library appends the “you have access to tools” instructions after yours.

### Recommended structure (XML-style tags)

Use XML-style tags to separate sections. `<role>` and `<instructions>` are clear, widely used choices:

```
<role>
Brief role name or one-line description
</role>

<instructions>
- Bullet or paragraph: what to do, how to respond, constraints.
- Optional: output format, language, or safety rules.
</instructions>
```

Other tags work well too — for example `<objective>`, `<constraints>`, `<examples>`, or custom section names. What matters is consistent, readable structure so the model can tell sections apart.

**Example**

```
<role>
Support assistant for Acme Corp. Be concise and professional.
</role>

<instructions>
- Answer only about Acme products and policies. Say "I can only help with Acme topics" for off-topic requests.
- Prefer short answers; link to docs when relevant.
</instructions>
```

### Format

- **String**: Pass any string; it will be merged with the base prompt.
- **SystemMessage**: You can pass a `SystemMessage` (e.g. with multi-block content) for full control; the base prompt is still prepended.

### Using the SystemPromptBuilder

The library exports a fluent builder so you can build system prompts without hand-writing XML:

```ts
import { SystemPromptBuilder } from "bullmq-ai-agent";

const systemPrompt = new SystemPromptBuilder()
  .role("Support assistant for Acme Corp. Be concise and professional.")
  .instructions(
    "Answer only about Acme products and policies. Say \"I can only help with Acme topics\" for off-topic requests.",
    "Prefer short answers; link to docs when relevant.",
  )
  .constraints("Never share internal pricing with competitors.")
  .build();
```

Available methods: `.role()`, `.instructions()`, `.objective()`, `.constraints()`, `.examples()`, `.section(tag, content)` for custom XML sections, and `.build()`.

**Templates:** You can put placeholders like `{name}` in any section content. Call `.build(params)` with a record of placeholder names to values; each `{key}` is replaced by `params[key]` (missing keys are left as-is). Example: `.section("messages", "Content:\n{messages}").build({ messages: "..." })`.

---

## 2. Tool descriptions

Each tool has a **description** the model uses to decide when and how to call it. Use clear sections so the model can tell when to use the tool and when not to.

### Recommended structure (Markdown)

- **Short intro** — One or two sentences: what the tool does.
- **`## When to Use This Tool`** — Bullet list of situations where the tool is appropriate.
- **`## How to Use This Tool`** — Numbered steps or usage rules (optional but helpful).
- **`## When NOT to Use This Tool`** — Bullet list of cases where the tool should not be used (and what to use instead, if relevant).

For complex tools you can add:

- **`## Examples`** — Optional. Use `<example>` and `<reasoning>` blocks to show a scenario and why the tool was or wasn’t used.

### Example

```markdown
Hand off the conversation to a human agent. Use when the user should be routed to a human and the agent should not continue.

## When to Use This Tool
- Complaints or sensitive issues that require human handling
- Requests that are out of scope for the agent
- User explicitly asks to speak to a human

## When NOT to Use This Tool
- For simple approval or confirmation: use request_human_approval instead so the agent can resume after the user responds.
- For routine questions the agent can answer.
```

Tool descriptions are static text; no placeholders or variables.

### Using the ToolDescriptionBuilder

The library exports a fluent builder for tool descriptions:

```ts
import { ToolDescriptionBuilder } from "bullmq-ai-agent";

const description = new ToolDescriptionBuilder()
  .intro("Hand off the conversation to a human agent. Use when the user should be routed to a human and the agent should not continue.")
  .whenToUse(
    "Complaints or sensitive issues that require human handling",
    "Requests that are out of scope for the agent",
    "User explicitly asks to speak to a human",
  )
  .whenNotToUse(
    "For simple approval or confirmation: use request_human_approval instead so the agent can resume after the user responds.",
    "For routine questions the agent can answer.",
  )
  .build();
```

Available methods: `.intro()`, `.whenToUse()`, `.whenNotToUse()`, `.howToUse()`, `.example(scenario, reasoning)`, `.section(heading, lines)` for extra sections (e.g. "Scopes"), and `.build()`.

---

## 3. Quick reference


| What you define      | Structure                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| **System prompt**    | XML-style tags for sections; `<role>` and `<instructions>` are clear choices; others (e.g. `<objective>`, `<constraints>`) work too. Your text is merged with the base prompt. |
| **Tool description** | Short intro + `## When to Use` + `## When NOT to Use` (Markdown). Optional: `## How to Use`, `## Examples`. |


---

## 4. Do’s and don’ts

**Do**

- Use XML-style tags in the system prompt for clear structure; `<role>` and `<instructions>` are good defaults, and other section tags work well too.
- In tool descriptions, use `## When to Use` and `## When NOT to Use` to reduce misuse.
- Put tool-specific rules in the tool description, not only in the system prompt.

**Don’t**

- Rely on long, unstructured paragraphs; sections and bullets help the model follow instructions.
- Omit “when NOT to use” for tools that have a narrow or easily confused use case.

Following these guidelines will make your system prompts and tool descriptions work consistently with the agent.