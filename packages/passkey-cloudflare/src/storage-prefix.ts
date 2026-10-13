// The storage prefix: a prefix on the name of every Durable Object instance a
// store addresses, so two prefixes never share an instance. It is set only in
// code, never from a var or secret, so a deploy setting cannot point an
// application at different storage. An empty or absent prefix gives each
// instance its unprefixed name.
//
// No unprefixed instance name contains "/", so a prefixed name, which always
// does, can never equal one, and a prefixed name's prefix is everything before
// its last "/", so no two prefixes share a name.

/** The instance name `name` takes under `storagePrefix`. */
export function prefixedName(storagePrefix: string | undefined, name: string): string {
  if (!storagePrefix) return name;
  if (name.includes("/")) throw new Error(`instance name ${name} contains "/"`);
  return `${storagePrefix}/${name}`;
}

/** The stub for the instance named `name` under `storagePrefix`. */
export function prefixedInstance<T extends Rpc.DurableObjectBranded | undefined>(
  binding: DurableObjectNamespace<T>,
  storagePrefix: string | undefined,
  name: string,
): DurableObjectStub<T> {
  return binding.get(binding.idFromName(prefixedName(storagePrefix, name)));
}
