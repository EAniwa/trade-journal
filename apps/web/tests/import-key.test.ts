import {expect,it,vi} from "vitest";
import {newImportKey} from "../src/lib/hosted-client";
it("creates independent import keys on HTTP iOS where randomUUID is absent",()=>{
  let seed=0;vi.stubGlobal("crypto",{getRandomValues:(bytes:Uint8Array)=>{bytes.fill(++seed);return bytes;}});
  try {const first=newImportKey(),second=newImportKey();expect(first).toMatch(/^[0-9a-f]{32}$/);expect(first).not.toBe(second);}finally{vi.unstubAllGlobals();}
});
