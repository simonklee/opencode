import { afterEach, describe, expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"

const original = {
  onmessage: globalThis.onmessage,
  postMessage: globalThis.postMessage,
}

describe("util.rpc", () => {
  afterEach(() => {
    globalThis.onmessage = original.onmessage
    globalThis.postMessage = original.postMessage
  })

  function pair<T extends { [key: string]: (input: any) => any }>(rpc: T) {
    let onmessage: ((evt: MessageEvent<any>) => any) | null = null

    globalThis.postMessage = (data: string) => {
      onmessage?.({ data } as MessageEvent<any>)
    }

    Rpc.listen(rpc)
    const worker = globalThis.onmessage!

    const target: any = {
      postMessage(data: string) {
        void Promise.resolve((worker as any).call(globalThis, { data } as MessageEvent<any>)).catch(() => undefined)
      },
      get onmessage() {
        return onmessage
      },
      set onmessage(handler) {
        onmessage = handler
      },
    }

    return Rpc.client<T>(target)
  }

  test("returns rpc results", async () => {
    const client = pair({
      async ping(input: { value: string }) {
        return input.value
      },
    })

    await expect(client.call("ping", { value: "pong" })).resolves.toBe("pong")
  })

  test("rejects when the rpc handler throws", async () => {
    const client = pair({
      async shutdown() {
        throw new Error("boom")
      },
    })

    const result = await Promise.race([
      client.call("shutdown", undefined).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((resolve) => {
        setTimeout(() => resolve("timeout"), 25)
      }),
    ])

    expect(result).toBe("rejected")
  })

  test("rejects when the rpc handler throws synchronously", async () => {
    const client = pair({
      reload() {
        throw new Error("boom")
      },
    })

    const result = await Promise.race([
      client.call("reload", undefined).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((resolve) => {
        setTimeout(() => resolve("timeout"), 25)
      }),
    ])

    expect(result).toBe("rejected")
  })
})
