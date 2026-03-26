import { describe, expect, it } from "vitest";

import {
  renderSectionContent,
  SystemPromptBuilder,
  ToolDescriptionBuilder,
} from "./promptBuilders.js";

describe("renderSectionContent", () => {
  it("renders string as trimmed prose", () => {
    expect(renderSectionContent("  hello  ")).toBe("hello");
  });

  it("renders string array as bullets", () => {
    expect(renderSectionContent(["a", "- b"])).toBe("- a\n- b");
  });

  it("renders intro then bullets with blank line between", () => {
    expect(
      renderSectionContent({
        intro: "Something about the section...",
        bullets: ["point 1", "point 2"],
      }),
    ).toBe(
      "Something about the section...\n\n- point 1\n- point 2",
    );
  });

  it("joins intro string array as paragraphs", () => {
    expect(
      renderSectionContent({
        intro: ["First paragraph.", "Second paragraph."],
        bullets: ["one"],
      }),
    ).toBe("First paragraph.\n\nSecond paragraph.\n\n- one");
  });
});

describe("SystemPromptBuilder", () => {
  it("builds section with intro and bullets", () => {
    const s = new SystemPromptBuilder()
      .section("todo_list", {
        intro: "Overview text.",
        bullets: ["a", "b"],
      })
      .build();
    expect(s).toContain("<todo_list>");
    expect(s).toContain("Overview text.");
    expect(s).toContain("- a");
    expect(s).toContain("- b");
  });

  it("instructions accepts object form as sole argument", () => {
    const s = new SystemPromptBuilder()
      .instructions({
        intro: "Do this first.",
        bullets: ["rule one", "rule two"],
      })
      .build();
    expect(s).toContain("<instructions>");
    expect(s).toContain("Do this first.");
    expect(s).toContain("- rule one");
  });
});

describe("ToolDescriptionBuilder", () => {
  it("section supports intro and bullets under heading", () => {
    const d = new ToolDescriptionBuilder()
      .intro("Short intro.")
      .section("Details", {
        intro: "More context here.",
        bullets: ["Use when X", "Skip when Y"],
      })
      .build();
    expect(d).toContain("## Details");
    expect(d).toContain("More context here.");
    expect(d).toContain("- Use when X");
    expect(d).toContain("- Skip when Y");
  });
});
