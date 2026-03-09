import { describe, expect, mock, test } from "bun:test"

const src = import.meta.dir + "/../../../src"
const mod = {
  helper: src + "/cli/cmd/tui/context/helper.tsx",
  exit: src + "/cli/cmd/tui/context/exit.tsx",
  route: src + "/cli/cmd/tui/context/route.tsx",
  win32: src + "/cli/cmd/tui/win32.ts",
  clip: src + "/cli/cmd/tui/util/clipboard.ts",
  proc: src + "/util/process.ts",
  which: src + "/util/which.ts",
}

const init: Record<string, (...args: never[]) => unknown> = {}
const seen = {
  destroy: 0,
  exit: 0,
  flush: 0,
  title: [] as string[],
}

function helper(input: { name: string; init: (...args: never[]) => unknown }) {
  init[input.name] = input.init
  return {
    use: undefined,
    provider: undefined,
  }
}

mock.module("../../../src/cli/cmd/tui/context/helper", () => ({
  createSimpleContext: helper,
}))

mock.module(mod.helper, () => ({
  createSimpleContext: helper,
}))

mock.module("solid-js/store", () => ({
  createStore: <T extends Record<string, unknown>>(value: T) => {
    const store = { ...value }
    const setStore = (next: T) => {
      Object.assign(store, next)
    }
    return [store, setStore] as const
  },
}))

mock.module("@opentui/solid", () => ({
  useRenderer: () => ({
    destroy() {
      seen.destroy++
    },
    setTerminalTitle(value: string) {
      seen.title.push(value)
    },
  }),
}))

mock.module("@/cli/error", () => ({
  FormatError: (input: unknown) => (input instanceof Error ? input.message : undefined),
  FormatUnknownError: (input: unknown) => String(input),
}))

mock.module("../../../src/cli/cmd/tui/win32", () => ({
  win32FlushInputBuffer: () => {
    seen.flush++
  },
}))

mock.module("../../../src/cli/cmd/tui/win32.ts", () => ({
  win32FlushInputBuffer: () => {
    seen.flush++
  },
}))

mock.module(mod.win32, () => ({
  win32FlushInputBuffer: () => {
    seen.flush++
  },
}))

mock.module("os", () => ({
  platform: () => "linux",
  release: () => "",
  tmpdir: () => "/tmp",
}))

mock.module("clipboardy", () => ({
  default: {
    read: async () => "",
    write: async () => {},
  },
}))

mock.module(mod.proc, () => ({
  Process: {
    spawn: () => ({
      stdin: {
        write() {},
        end() {},
      },
      exited: Promise.resolve(0),
    }),
  },
}))

mock.module(mod.which, () => ({
  which: (input: string) => input === "xclip",
}))

describe("tui runtime", () => {
  test("only performs terminal cleanup and output once when exit is triggered repeatedly", async () => {
    await import(mod.exit)

    seen.destroy = 0
    seen.exit = 0
    seen.flush = 0
    seen.title.length = 0

    const out: string[] = []
    const err: string[] = []
    const stdout = process.stdout.write
    const stderr = process.stderr.write
    ;(process.stdout as { write: typeof process.stdout.write }).write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    ;(process.stderr as { write: typeof process.stderr.write }).write = ((chunk: string | Uint8Array) => {
      err.push(String(chunk))
      return true
    }) as typeof process.stderr.write

    try {
      const exit = init.Exit as (input: { onExit?: () => Promise<void> }) => {
        message: { set: (value?: string) => () => void }
      } & ((reason?: unknown) => Promise<void>)
      const call = exit({
        onExit: async () => {
          seen.exit++
        },
      })

      call.message.set("bye")
      const reason = new Error("boom")
      await Promise.all([call(reason), call(reason), call(reason)])

      expect(seen.title).toEqual([""])
      expect(seen.destroy).toBe(1)
      expect(seen.flush).toBe(1)
      expect(seen.exit).toBe(1)
      expect(out).toEqual(["bye\n"])
      expect(err).toEqual(["boom\n"])
    } finally {
      ;(process.stdout as { write: typeof process.stdout.write }).write = stdout
      ;(process.stderr as { write: typeof process.stderr.write }).write = stderr
    }
  })

  test("navigate does not print debug output", async () => {
    await import(mod.route)

    const route = init.Route as () => {
      data: unknown
      navigate: (input: { type: string; sessionID: string }) => void
    }
    const ctx = route()
    const logs: unknown[][] = []
    const log = console.log
    console.log = (...input: unknown[]) => {
      logs.push(input)
    }

    try {
      ctx.navigate({ type: "session", sessionID: "abc" })
    } finally {
      console.log = log
    }

    expect(ctx.data).toEqual({ type: "session", sessionID: "abc" })
    expect(logs).toHaveLength(0)
  })

  test("copy does not print debug output while selecting a native copy path", async () => {
    const { Clipboard } = await import(mod.clip)
    const logs: unknown[][] = []
    const log = console.log
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
    console.log = (...input: unknown[]) => {
      logs.push(input)
    }
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    })

    try {
      await Clipboard.copy("hello")
    } finally {
      console.log = log
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty)
      else delete (process.stdout as { isTTY?: boolean }).isTTY
    }

    expect(logs).toHaveLength(0)
  })
})
