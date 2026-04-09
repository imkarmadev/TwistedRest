import { describe, test, expect } from "bun:test";
import { zodFromJson, zodFromJsonString } from "./from-json";

describe("zodFromJson", () => {
  test("string", () => {
    expect(zodFromJson("hello")).toBe("z.string()");
  });

  test("integer", () => {
    expect(zodFromJson(42)).toBe("z.number().int()");
  });

  test("float", () => {
    expect(zodFromJson(3.14)).toBe("z.number()");
  });

  test("boolean", () => {
    expect(zodFromJson(true)).toBe("z.boolean()");
  });

  test("null", () => {
    expect(zodFromJson(null)).toBe("z.null()");
  });

  test("empty array", () => {
    expect(zodFromJson([])).toBe("z.array(z.unknown())");
  });

  test("array of strings", () => {
    expect(zodFromJson(["a", "b"])).toBe("z.array(z.string())");
  });

  test("array of objects", () => {
    const result = zodFromJson([{ id: 1, name: "x" }]);
    expect(result).toContain("z.array(z.object(");
    expect(result).toContain("id: z.number().int()");
    expect(result).toContain("name: z.string()");
  });

  test("nested object", () => {
    const result = zodFromJson({ user: { name: "Alice" } });
    expect(result).toContain("user: z.object(");
    expect(result).toContain("name: z.string()");
  });

  test("empty object", () => {
    expect(zodFromJson({})).toBe("z.object({})");
  });

  test("special key names get quoted", () => {
    const result = zodFromJson({ "with-dash": 1 });
    expect(result).toContain('"with-dash"');
  });
});

describe("zodFromJsonString", () => {
  test("valid JSON", () => {
    const result = zodFromJsonString('{"id": 1}');
    expect(result).not.toBeNull();
    expect(result).toContain("id: z.number().int()");
  });

  test("invalid JSON returns null", () => {
    expect(zodFromJsonString("not json")).toBeNull();
  });

  test("empty string returns null", () => {
    expect(zodFromJsonString("")).toBeNull();
  });
});
