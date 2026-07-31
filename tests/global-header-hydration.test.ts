// @vitest-environment jsdom

import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import GlobalHeader from "@/components/common/GlobalHeader";
import GlobalMobileMenu from "@/components/common/GlobalMobileMenu";

type AuthState = {
  user: { id: string } | null;
  loading: boolean;
};

let authState: AuthState = { user: null, loading: false };
const mountedRoots = new Set<Root>();
const storage = new Map<string, string>();
const localStorageMock: Storage = {
  get length() {
    return storage.size;
  },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => Array.from(storage.keys())[index] ?? null,
  removeItem: (key) => storage.delete(key),
  setItem: (key, value) => storage.set(key, value),
};

beforeAll(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", localStorageMock);
});

vi.mock("@/components/AuthProvider", () => ({
  useAuth: () => authState,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/board",
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    createElement("a", { href, ...props }, children),
}));

vi.mock("@/hooks/useRealtimeToast", () => ({
  useRealtimeToast: vi.fn(),
}));

vi.mock("@/components/map/NotificationDropdown", () => ({
  default: () => null,
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn() },
}));

vi.mock("vaul", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => children;

  return {
    Drawer: {
      Root: Passthrough,
      Portal: Passthrough,
      Overlay: (props: ComponentProps<"div">) => createElement("div", props),
      Content: (props: ComponentProps<"div">) => createElement("div", props),
      Title: Passthrough,
      Description: (props: ComponentProps<"p">) => createElement("p", props),
    },
  };
});

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: table === "profiles"
              ? { id: "admin-user", nickname: "관리자", role: "admin" }
              : null,
            error: null,
          }),
          order: async () => ({ data: [], error: null }),
        }),
      }),
      update: () => ({
        eq: () => ({ eq: async () => ({ data: null, error: null }) }),
      }),
    }),
    channel: () => ({
      on() {
        return this;
      },
      subscribe() {
        return this;
      },
    }),
    removeChannel: vi.fn(),
    auth: { signOut: vi.fn() },
  },
}));

const signedInState: AuthState = {
  user: { id: "admin-user" },
  loading: false,
};

const signedOutState: AuthState = {
  user: null,
  loading: false,
};

async function hydrateWithAuthChange(
  serverElement: ReactNode,
  clientElement: ReactNode,
  clientAuthState: AuthState,
) {
  authState = signedOutState;
  const container = document.createElement("div");
  container.innerHTML = renderToString(serverElement);
  document.body.append(container);
  const recoverableErrors: unknown[] = [];
  let root: Root | undefined;

  authState = clientAuthState;
  await act(async () => {
    root = hydrateRoot(container, clientElement, {
      onRecoverableError: (error) => recoverableErrors.push(error),
    });
    mountedRoots.add(root);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return { container, recoverableErrors, root };
}

afterEach(async () => {
  await act(async () => {
    mountedRoots.forEach((root) => root.unmount());
  });
  mountedRoots.clear();
  authState = signedOutState;
  document.body.replaceChildren();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("GlobalHeader 하이드레이션", () => {
  it("로그인 세션이 클라이언트에서 복원되어도 초기 렌더가 일치한다", async () => {
    const { container, recoverableErrors } = await hydrateWithAuthChange(
      createElement(GlobalHeader),
      createElement(GlobalHeader),
      signedInState,
    );

    expect(recoverableErrors).toHaveLength(0);
    expect(container.textContent).toContain("관리자");

  });

  it("비로그인 상태의 서버와 클라이언트 초기 렌더가 일치한다", async () => {
    const { container, recoverableErrors } = await hydrateWithAuthChange(
      createElement(GlobalHeader),
      createElement(GlobalHeader),
      signedOutState,
    );

    expect(recoverableErrors).toHaveLength(0);
    expect(container.textContent).toContain("로그인");

  });
});

describe("GlobalMobileMenu 하이드레이션", () => {
  const signedOutProps = {
    isOpen: true,
    setIsOpen: vi.fn(),
    activeMapId: "Erangel",
    isAdmin: false,
  };

  it("로그인 세션과 관리자 역할이 클라이언트에서 복원되어도 초기 렌더가 일치한다", async () => {
    localStorage.setItem("user_nickname", "관리자");
    const { container, recoverableErrors } = await hydrateWithAuthChange(
      createElement(GlobalMobileMenu, signedOutProps),
      createElement(GlobalMobileMenu, { ...signedOutProps, isAdmin: true }),
      signedInState,
    );

    expect(recoverableErrors).toHaveLength(0);
    expect(container.textContent).toContain("관리자");
    expect(container.textContent).toContain("Admin Console");

  });

  it("비로그인 상태의 서버와 클라이언트 초기 렌더가 일치한다", async () => {
    const { container, recoverableErrors } = await hydrateWithAuthChange(
      createElement(GlobalMobileMenu, signedOutProps),
      createElement(GlobalMobileMenu, signedOutProps),
      signedOutState,
    );

    expect(recoverableErrors).toHaveLength(0);
    expect(container.textContent).toContain("익명 사용자");
    expect(container.textContent).not.toContain("Admin Console");

  });
});
