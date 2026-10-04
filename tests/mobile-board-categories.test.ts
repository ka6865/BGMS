import { describe, expect, it } from "vitest";
import { boardCategoryFilterValues, parseCurrentBoardCategory } from "../lib/board/mobileCategories";

describe("mobile board category compatibility", () => {
  it("legacy clan filters also return the current 웹 클랜홍보 records", () => {
    expect(boardCategoryFilterValues("clan")).toEqual(["clan", "클랜", "클랜홍보"]);
    expect(boardCategoryFilterValues("클랜")).toEqual(["clan", "클랜", "클랜홍보"]);
    expect(boardCategoryFilterValues("클랜홍보")).toEqual(["clan", "클랜", "클랜홍보"]);
  });

  it("new posts accept only the current shared categories", () => {
    expect(parseCurrentBoardCategory("클랜홍보")).toBe("클랜홍보");
    expect(parseCurrentBoardCategory("clan")).toBeNull();
  });
});
