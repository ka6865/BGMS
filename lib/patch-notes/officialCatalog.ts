import { parse } from "acorn";

type Node = { type: string; name?: string; value?: unknown; operator?: string; argument?: Node; properties?: Node[]; key?: Node; computed?: boolean; elements?: Node[]; params?: Node[]; arguments?: Node[]; callee?: Node; expression?: Node; body?: Node | Node[] };
export interface OfficialItem {
  key: string;
  name: string;
  updated: string;
  ammunition: string | null;
  specs: Record<string, string>;
  official: Record<string, unknown>;
}

/** 외부 스크립트를 실행하지 않고 정적 Nuxt 데이터만 해석한다. */
export function parseOfficialCatalog(html: string): OfficialItem[] {
  const script = html.match(/window\.__NUXT__=([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("공식 도감 데이터 구조를 확인할 수 없습니다.");
  const program = parse(script, { ecmaVersion: "latest" }) as unknown as Node;
  const call = (program.body as Node[])?.[0]?.expression;
  const fn = call?.callee;
  if (call?.type !== "CallExpression" || fn?.type !== "FunctionExpression" || !fn.params || !call.arguments || fn.params.length !== call.arguments.length) throw new Error("공식 도감 값의 형식이 변경되었습니다.");
  const args = new Map(fn.params.map((param, index) => [param.name, call.arguments![index]]));
  function read(node: Node | undefined): unknown {
    if (!node) throw new Error("공식 도감 값이 누락되었습니다.");
    switch (node.type) {
      case "Literal": return node.value;
      case "Identifier": return read(args.get(node.name));
      case "ArrayExpression": return node.elements?.map(read);
      case "ObjectExpression": return Object.fromEntries((node.properties ?? []).map((property) => {
        if (property.type !== "Property" || property.computed) throw new Error("공식 도감 구조를 해석할 수 없습니다.");
        return [String(property.key?.name ?? property.key?.value), read(property.value as Node)];
      }));
      case "UnaryExpression": {
        const value = read(node.argument);
        if (node.operator === "-") return -Number(value);
        if (node.operator === "!") return !value;
        if (node.operator === "void") return null;
        throw new Error("지원하지 않는 공식 도감 값입니다.");
      }
      default: throw new Error("지원하지 않는 공식 도감 구조입니다.");
    }
  }
  const body = fn.body as Node;
  const data = read((body.body as Node[])?.[0]?.argument) as { fetch?: Record<string, { weaponCategories?: Category[]; vehicleCategories?: Category[] }> };
  const entry = Object.values(data.fetch ?? {}).find((value) => value.weaponCategories || value.vehicleCategories);
  const categories = entry?.weaponCategories ?? entry?.vehicleCategories;
  if (!Array.isArray(categories)) throw new Error("공식 도감 분류를 찾지 못했습니다.");
  const items = categories.flatMap((category) => category.weapons ?? category.vehicles ?? []);
  if (!items.length) throw new Error("공식 도감 항목을 찾지 못했습니다.");
  return [...new Map(items.map((item) => {
    if (typeof item.key !== "string" || typeof item.name !== "string" || typeof item.updateDate !== "string" || !Array.isArray(item.feature?.specs)) throw new Error("공식 도감 항목이 누락되었습니다.");
    const specs = Object.fromEntries(item.feature.specs.map((spec) => [spec.title, spec.data]));
    const result: OfficialItem = { key: item.key, name: item.name, updated: item.updateDate, ammunition: typeof item.ammunition === "string" ? item.ammunition : null, specs, official: item };
    return [item.key, result] as const;
  })).values()];
}

type RawItem = Record<string, unknown> & { key: string; name: string; updateDate: string; feature: { specs: { title: string; data: string }[] } };
type Category = { weapons?: RawItem[]; vehicles?: RawItem[] };
