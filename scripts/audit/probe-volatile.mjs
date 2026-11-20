// 验证：.volatile() 字段经 schema 校验后到底是值还是引用对象？
import { schemasteryUrl } from './paths.mjs'
const mod = await import(schemasteryUrl())
const Schema = mod.default

const schema = Schema.object({
  flag: Schema.boolean().default(true).volatile(),
  ver: Schema.string().default('3.13').volatile(),
  plain: Schema.boolean().default(false),
})

const out = schema({})
const describe = (v) => {
  const t = typeof v
  const keys = v && typeof v === 'object' ? Reflect.ownKeys(v).map(String) : []
  return { type: t, keys, hasGet: !!(v && typeof v.get === 'function'), value: t === 'object' ? undefined : v }
}
console.log('typeof schema:', typeof schema, 'has ~standard:', !!(schema && schema['~standard']))
for (const [k, v] of Object.entries(out)) console.log(k, JSON.stringify(describe(v)))

// 兼容的写法：既有普通值又有 volatile 时的解包测试
const unwrap = (v) => (v && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v)
console.log('unwrap flag =', unwrap(out.flag), '| unwrap ver =', unwrap(out.ver), '| unwrap plain =', unwrap(out.plain))

// 显式赋值时也检查
const out2 = schema({ flag: false, ver: '3.12' })
for (const [k, v] of Object.entries(out2)) console.log('explicit', k, JSON.stringify(describe(v)))
