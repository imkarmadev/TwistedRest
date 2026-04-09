import { describe, test, expect } from "bun:test";
import { parseTemplate, inputPinsFor, renderTemplate } from "./template";

describe("parseTemplate", () => {
  test("empty string returns no tokens", () => {
    expect(parseTemplate("")).toEqual([]);
  });

  test("no tokens returns empty", () => {
    expect(parseTemplate("https://api.example.com/users")).toEqual([]);
  });

  test("single token", () => {
    const tokens = parseTemplate("https://api.com/users/#{userId}");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.name).toBe("userId");
    expect(tokens[0]!.path).toEqual([]);
    expect(tokens[0]!.raw).toBe("#{userId}");
  });

  test("multiple tokens", () => {
    const tokens = parseTemplate("#{base}/#{path}?key=#{apiKey}");
    expect(tokens).toHaveLength(3);
    expect(tokens.map((t) => t.name)).toEqual(["base", "path", "apiKey"]);
  });

  test("dotted path", () => {
    const tokens = parseTemplate("#{user.address.city}");
    expect(tokens[0]!.name).toBe("user");
    expect(tokens[0]!.path).toEqual(["address", "city"]);
  });

  test("duplicate tokens preserved", () => {
    const tokens = parseTemplate("#{x} and #{x}");
    expect(tokens).toHaveLength(2);
  });

  test("does not match bare # without braces", () => {
    expect(parseTemplate("#notAToken")).toEqual([]);
  });
});

describe("inputPinsFor", () => {
  test("returns unique pin names", () => {
    const pins = inputPinsFor("#{a} #{b} #{a}");
    expect(pins).toEqual(["a", "b"]);
  });

  test("empty string returns empty", () => {
    expect(inputPinsFor("")).toEqual([]);
  });
});

describe("renderTemplate", () => {
  test("substitutes simple values", () => {
    expect(renderTemplate("Hello #{name}!", { name: "world" })).toBe(
      "Hello world!",
    );
  });

  test("substitutes numbers", () => {
    expect(renderTemplate("/users/#{id}", { id: 42 })).toBe("/users/42");
  });

  test("substitutes booleans", () => {
    expect(renderTemplate("#{flag}", { flag: true })).toBe("true");
  });

  test("missing values become empty string", () => {
    expect(renderTemplate("#{missing}", {})).toBe("");
  });

  test("dotted path drills into objects", () => {
    expect(
      renderTemplate("#{user.name}", { user: { name: "Alice" } }),
    ).toBe("Alice");
  });

  test("deep dotted path", () => {
    expect(
      renderTemplate("#{a.b.c}", { a: { b: { c: "deep" } } }),
    ).toBe("deep");
  });

  test("dotted path with missing intermediate returns empty", () => {
    expect(renderTemplate("#{a.b.c}", { a: null })).toBe("");
  });

  test("objects get JSON-stringified", () => {
    const result = renderTemplate("#{obj}", { obj: { x: 1 } });
    expect(result).toBe('{"x":1}');
  });

  test("null/undefined become empty", () => {
    expect(renderTemplate("#{a}#{b}", { a: null, b: undefined })).toBe("");
  });
});
