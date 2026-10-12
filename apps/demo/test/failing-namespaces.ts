// Durable Object namespaces that fail as an unreachable object would, or that
// count the calls made to them, for a test to put in place of a real binding
// through `app.vars`.

/** The real namespace, with each stub it hands out looked up through `get`. */
function withStubs<N extends object>(real: N, get: ProxyHandler<DurableObjectStub>["get"]): N {
  const namespace = real as unknown as DurableObjectNamespace;
  const stub = (id: DurableObjectId) => new Proxy(namespace.get(id), { get });
  return new Proxy(real, {
    get: (target, property) => {
      if (property === "get") return stub;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A namespace whose stubs answer these methods with the given functions instead. */
export function overriding<N extends object>(
  real: N,
  methods: Record<string, (...args: any[]) => Promise<unknown>>,
): N {
  return withStubs(real, (target, property) =>
    typeof property === "string" && property in methods ? methods[property] : Reflect.get(target, property),
  );
}

/** A namespace whose objects reject every call to `method`. */
export function rejecting<N extends object>(real: N, method: string): N {
  return overriding(real, {
    [method]: async () => {
      throw new Error(`${method} failed`);
    },
  });
}

/** A namespace whose stubs pass every call through, recording each method called, in order, in `calls`. */
export function counting<N extends object>(real: N): { namespace: N; calls: string[] } {
  const calls: string[] = [];
  const namespace = withStubs(real, (target, property) => {
    const value = Reflect.get(target, property);
    if (typeof property !== "string" || typeof value !== "function") return value;
    return (...args: unknown[]) => {
      calls.push(property);
      return value(...args);
    };
  });
  return { namespace, calls };
}
