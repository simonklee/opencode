import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"

const stop = new Error("stop")
const fail = new Error("config failed")

const state = {
  config: undefined as Error | undefined,
  external: false,
  mode: "throw" as "throw" | "hang",
  server: undefined as Error | undefined,
  shutdownMode: "resolve" as "resolve" | "hang",
  shutdown: undefined as Error | undefined,
}

const seen = {
  tui: [] as string[],
  inst: [] as string[],
  rpc: [] as string[],
  term: 0,
}

mock.module("../../../src/cli/cmd/tui/app", () => ({
  tui: async (input: { directory: string }) => {
    seen.tui.push(input.directory)
    if (state.mode === "hang") return new Promise<void>(() => {})
    throw stop
  },
}))

mock.module("@/util/rpc", () => ({
  Rpc: {
    client: () => ({
      call: async (method: string) => {
        seen.rpc.push(method)
        if (method === "shutdown") {
          if (state.shutdownMode === "hang") return new Promise<void>(() => {})
          if (state.shutdown) throw state.shutdown
          return undefined
        }
        if (method === "server") {
          if (state.server) throw state.server
          return { url: "http://127.0.0.1" }
        }
        return undefined
      },
      on: () => {},
    }),
  },
}))

mock.module("@/cli/ui", () => ({
  UI: {
    error: () => {},
  },
}))

mock.module("@/util/log", () => ({
  Log: {
    init: async () => {},
    create: () => ({
      error: () => {},
      info: () => {},
      warn: () => {},
      debug: () => {},
      time: () => ({ stop: () => {} }),
    }),
    Default: {
      error: () => {},
      info: () => {},
      warn: () => {},
      debug: () => {},
    },
  },
}))

mock.module("@/util/timeout", () => ({
  withTimeout: <T>(input: Promise<T>) =>
    Promise.race([
      input,
      new Promise<T>((_, reject) => {
        setTimeout(() => reject(new Error("timeout")), 10)
      }),
    ]),
}))

mock.module("@/cli/network", () => ({
  withNetworkOptions: <T>(input: T) => input,
  resolveNetworkOptions: async () => ({
    mdns: false,
    port: state.external ? 1 : 0,
    hostname: "127.0.0.1",
  }),
}))

mock.module("../../../src/cli/cmd/tui/win32", () => ({
  win32DisableProcessedInput: () => {},
  win32FlushInputBuffer: () => {},
  win32InstallCtrlCGuard: () => undefined,
}))

mock.module("@/config/tui", () => ({
  TuiConfig: {
    get: async () => {
      if (state.config) throw state.config
      return {}
    },
  },
}))

mock.module("@/util/filesystem", () => ({
  Filesystem: {
    resolve: (input: string) => path.resolve(input),
    exists: async () => false,
  },
}))

mock.module("@/project/instance", () => ({
  Instance: {
    provide: async (input: { directory: string; fn: () => Promise<unknown> | unknown }) => {
      seen.inst.push(input.directory)
      return input.fn()
    },
  },
}))

describe("tui thread", () => {
  afterEach(() => {
    state.config = undefined
    state.external = false
    state.mode = "throw"
    state.server = undefined
    state.shutdownMode = "resolve"
    state.shutdown = undefined
    seen.tui.length = 0
    seen.inst.length = 0
    seen.rpc.length = 0
    seen.term = 0
  })

  async function call(project?: string) {
    const { TuiThreadCommand } = await import("../../../src/cli/cmd/tui/thread")
    const args: Parameters<NonNullable<typeof TuiThreadCommand.handler>>[0] = {
      _: [],
      $0: "opencode",
      project,
      prompt: "hi",
      model: undefined,
      agent: undefined,
      session: undefined,
      continue: false,
      fork: false,
      port: 0,
      hostname: "127.0.0.1",
      mdns: false,
      "mdns-domain": "opencode.local",
      mdnsDomain: "opencode.local",
      cors: [],
    }
    return TuiThreadCommand.handler(args)
  }

  async function withThread(project: string | undefined, fn: (dir: string) => Promise<void>) {
    await using tmp = await tmpdir({ git: true })
    const cwd = process.cwd()
    const pwd = process.env.PWD
    const worker = globalThis.Worker
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"
    await fs.symlink(tmp.path, link, type)

    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    })
    globalThis.Worker = class extends EventTarget {
      onerror = null
      onmessage = null
      onmessageerror = null
      postMessage() {}
      terminate() {
        seen.term++
      }
    } as unknown as typeof Worker

    try {
      process.chdir(tmp.path)
      process.env.PWD = link
      await fn(tmp.path)
    } finally {
      process.chdir(cwd)
      if (pwd === undefined) delete process.env.PWD
      else process.env.PWD = pwd
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
      else delete (process.stdin as { isTTY?: boolean }).isTTY
      globalThis.Worker = worker
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  test("uses the real cwd when PWD points at a symlink", async () => {
    await withThread(undefined, async (dir) => {
      await expect(call()).rejects.toBe(stop)
      expect(seen.inst[0]).toBe(dir)
      expect(seen.tui[0]).toBe(dir)
      expect(seen.rpc).toContain("shutdown")
      expect(seen.term).toBe(1)
    })
  })

  test("uses the real cwd after resolving a relative project from PWD", async () => {
    await withThread(".", async (dir) => {
      await expect(call(".")).rejects.toBe(stop)
      expect(seen.inst[0]).toBe(dir)
      expect(seen.tui[0]).toBe(dir)
      expect(seen.rpc).toContain("shutdown")
      expect(seen.term).toBe(1)
    })
  })

  test("shuts the worker down when startup fails before tui begins", async () => {
    state.config = fail

    await withThread(undefined, async () => {
      await expect(call()).rejects.toBe(fail)
      expect(seen.rpc).toContain("shutdown")
      expect(seen.term).toBe(1)
    })
  })

  test("still terminates the worker when shutdown rpc fails", async () => {
    state.shutdown = new Error("shutdown failed")

    await withThread(undefined, async () => {
      await expect(call()).rejects.toBe(stop)
      expect(seen.rpc.filter((x) => x === "shutdown")).toHaveLength(1)
      expect(seen.term).toBe(1)
    })
  })

  test("still terminates the worker when shutdown rpc hangs", async () => {
    state.shutdownMode = "hang"

    await withThread(undefined, async () => {
      await expect(call()).rejects.toBe(stop)
      expect(seen.rpc.filter((x) => x === "shutdown")).toHaveLength(1)
      expect(seen.term).toBe(1)
    })
  })

  test("shuts the worker down when external server startup fails before tui begins", async () => {
    state.external = true
    state.server = new Error("server failed")

    await withThread(undefined, async () => {
      await expect(call()).rejects.toBe(state.server)
      expect(seen.rpc).toContain("server")
      expect(seen.rpc).toContain("shutdown")
      expect(seen.term).toBe(1)
    })
  })

  test("does not hang forever when tui never settles", async () => {
    state.mode = "hang"

    await withThread(undefined, async () => {
      const result = await Promise.race([
        call().then(
          () => "settled",
          () => "settled",
        ),
        new Promise((resolve) => {
          setTimeout(() => resolve("timeout"), 25)
        }),
      ])

      expect(result).toBe("settled")
      expect(seen.rpc).toContain("shutdown")
    })
  })
})
