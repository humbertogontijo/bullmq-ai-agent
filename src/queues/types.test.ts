import { describe, it, expect } from "vitest";
import {
  flattenTodoSequence,
  resolveTodos,
  type TodoItem,
  type TodoItemsGraph,
  type TodoSequenceSpec,
} from "./types.js";

function p(content: string): TodoItem {
  return { content, status: "pending", fulfillment: "" };
}

describe("resolveTodos", () => {
  it("merges parallel top-level segments (graph + leaf) on first run", () => {
    const contactGraph: TodoItemsGraph = {
      items: [p("Get the client's full name")],
      next: {
        items: [p("Get the client's email address"), p("Get the client's shipping address")],
      },
    };
    const spec: TodoSequenceSpec = [contactGraph, p("Confirm all details with the client")];
    const resolved = resolveTodos(spec, []);
    expect(resolved).toHaveLength(2);
    const flat = flattenTodoSequence(resolved);
    expect(flat.map((t) => t.content)).toEqual([
      "Get the client's full name",
      "Confirm all details with the client",
    ]);
  });

  it("keeps TodoItemsGraph.items sequential (only first incomplete step)", () => {
    const spec: TodoSequenceSpec = [
      {
        items: [p("A"), p("B")],
      },
    ];
    const resolved = resolveTodos(spec, []);
    expect(resolved).toHaveLength(1);
    const inner = (resolved[0] as TodoItemsGraph).items;
    expect(inner).toHaveLength(1);
    expect((inner[0] as TodoItem).content).toBe("A");
  });

  it("advances sequential items after the first is completed in persisted state", () => {
    const spec: TodoSequenceSpec = [{ items: [p("A"), p("B")] }];
    const persisted: TodoItem[] = [
      { content: "A", status: "completed", fulfillment: "done" },
    ];
    const resolved = resolveTodos(spec, persisted);
    expect(flattenTodoSequence(resolved).map((t) => t.content)).toEqual(["B"]);
  });
});
