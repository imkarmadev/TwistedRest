import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { pinsFromSchema } from "./walk";

describe("pinsFromSchema", () => {
  test("object schema returns one pin per field", () => {
    const schema = z.object({ id: z.number(), name: z.string() });
    const pins = pinsFromSchema(schema);
    expect(pins).toHaveLength(2);
    expect(pins[0]!.id).toBe("id");
    expect(pins[0]!.dataType).toBe("number");
    expect(pins[1]!.id).toBe("name");
    expect(pins[1]!.dataType).toBe("string");
  });

  test("all pins are data/out", () => {
    const pins = pinsFromSchema(z.object({ x: z.string() }));
    expect(pins[0]!.kind).toBe("data");
    expect(pins[0]!.direction).toBe("out");
  });

  test("boolean field", () => {
    const pins = pinsFromSchema(z.object({ active: z.boolean() }));
    expect(pins[0]!.dataType).toBe("boolean");
  });

  test("nested object field", () => {
    const pins = pinsFromSchema(
      z.object({ meta: z.object({ count: z.number() }) }),
    );
    expect(pins[0]!.dataType).toBe("object");
    expect(pins[0]!.inner).toBeTruthy();
  });

  test("array field", () => {
    const pins = pinsFromSchema(
      z.object({ tags: z.array(z.string()) }),
    );
    expect(pins[0]!.dataType).toBe("array");
  });

  test("optional field unwraps", () => {
    const pins = pinsFromSchema(
      z.object({ opt: z.string().optional() }),
    );
    expect(pins[0]!.dataType).toBe("string");
  });

  test("nullable field unwraps", () => {
    const pins = pinsFromSchema(
      z.object({ n: z.number().nullable() }),
    );
    expect(pins[0]!.dataType).toBe("number");
  });

  test("non-object schema returns single value pin", () => {
    const pins = pinsFromSchema(z.string());
    expect(pins).toHaveLength(1);
    expect(pins[0]!.id).toBe("value");
    expect(pins[0]!.dataType).toBe("string");
  });

  test("array schema returns single value pin", () => {
    const pins = pinsFromSchema(z.array(z.number()));
    expect(pins).toHaveLength(1);
    expect(pins[0]!.id).toBe("value");
    expect(pins[0]!.dataType).toBe("array");
  });
});
