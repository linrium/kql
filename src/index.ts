import * as util from "util"
import * as P from "parsimmon"
import axios from "axios"
import _ from "lodash"
import * as qs from "query-string"

// Turn escaped characters into real ones (e.g. "\\n" becomes "\n").
function interpretEscapes(str) {
  let escapes = {
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  }
  return str.replace(/\\(u[0-9a-fA-F]{4}|[^u])/, (_, escape) => {
    let type = escape.charAt(0)
    let hex = escape.slice(1)
    if (type === "u") {
      return String.fromCharCode(parseInt(hex, 16))
    }
    if (escapes.hasOwnProperty(type)) {
      return escapes[type]
    }
    return type
  })
}

// Use the JSON standard's definition of whitespace rather than Parsimmon's.
const whitespace = P.regexp(/\s*/m)
const optional = P.of(null)
const comment = P.regexp(/--.*/).or(optional)

// JSON is pretty relaxed about whitespace, so let's make it easy to ignore
// after most text.
function token(parser) {
  return parser.skip(whitespace).skip(comment)
}

// Several parsers are just strings with optional whitespace.
function word(str) {
  return token(comment).then(P.string(str)).thru(token)
}

const kql = P.createLanguage({
  // This is the main entry point of the parser: a full JSON value.
  value: (r) =>
    P.alt(
      r.object,
      r.array,
      r.string,
      r.number,
      r.null,
      r.true,
      r.false,
      r.fn,
      r.constants
    ).thru((parser) => whitespace.then(parser)),

  // The basic tokens in JSON, with optional whitespace afterward.
  lbrace: () => word("{"),
  rbrace: () => word("}"),
  lbracket: () => word("["),
  rbracket: () => word("]"),
  lParenthesis: () => word("("),
  rParenthesis: () => word(")"),
  comma: () => word(","),
  colon: () => word(":"),
  dot: () => word("."),
  and: () => word("and"),

  comment: () => token(comment),

  // `.result` is like `.map` but it takes a value instead of a function, and
  // always returns the same value.
  null: () => word("null").result(null),
  true: () => word("true").result(true),
  false: () => word("false").result(false),

  // Regexp based parsers should generally be named for better error reporting.
  string: () =>
    token(P.regexp(/(["'])((?:\\.|.)*?)(["'])/, 2))
      .map(interpretEscapes)
      .desc("string"),

  text: () => {
    return token(P.regexp(/[a-zA-Z0-9-_]*/))
      .map(interpretEscapes)
      .desc("string")
  },

  constants: () => {
    return P.alt(
      word("current_bounds"),
      word("current_points"),
      word("current_features")
    )
  },

  number: () =>
    token(P.regexp(/-?(0|[1-9][0-9]*)([.][0-9]+)?([eE][+-]?[0-9]+)?/))
      .map(Number)
      .desc("number"),

  // Array parsing is just ignoring brackets and commas and parsing as many nested
  // JSON documents as possible. Notice that we're using the parser `json` we just
  // defined above. Arrays and objects in the JSON grammar are recursive because
  // they can contain any other JSON document within them.
  array: (r) => r.lbracket.then(r.value.sepBy(r.comma)).skip(r.rbracket),

  // Object parsing is a little trickier because we have to collect all the key-
  // value pairs in order as length-2 arrays, then manually copy them into an
  // object.
  pair: (r) => P.seq(r.string.skip(r.colon), r.value),

  operator: () => {
    return P.alt(
      word("="),
      word(">"),
      word(">="),
      word("<"),
      word("<="),
      word("in")
    )
  },

  object: (r) => {
    return r.lbrace
      .then(r.pair.sepBy(r.comma))
      .skip(r.rbrace)
      .map((pairs) => {
        let object = {}
        pairs.forEach((pair) => {
          let [key, value] = pair
          object[key] = value
        })
        return object
      })
  },

  fn: (r) => {
    return P.seqObj<any, string>(
      ["fnName", r.text],
      ["arguments", r.value.sepBy(r.comma).wrap(r.lParenthesis, r.rParenthesis)]
    )
  },

  databaseName: (r) => {
    return P.alt(
      word("tile38"),
      word("metabase"),
      word("url"),
      word("t"),
      word("m"),
      word("u")
    )
  },

  asAlias: (r) => {
    return word("as").then(r.text).or(optional)
  },

  key: (r) => {
    return P.seqObj<string, any>(
      ["alias", r.text.skip(r.dot).or(optional)],
      ["key", r.text]
    )
  },

  pairCondition: (r) => {
    return r.comment.then(
      P.seqObj<string, any>(
        ["left", r.key],
        ["operator", r.operator],
        ["right", r.value]
      )
    )
  },

  where: (r) => {
    return word("where").then(r.pairCondition.sepBy(r.and))
  },

  joinCondition: (r) => {
    return P.seqObj<string, any>(["left", r.key], word("="), ["right", r.key])
  },

  join: (r) => {
    return word("join")
      .skip(r.databaseName)
      .skip(word("on"))
      .then(r.joinCondition)
  },

  limit: (r) => {
    return word("limit").then(r.number)
  },

  select: (r) => {
    return P.seqObj<any, any>(
      ["command", word("select")],
      word("*"),
      word("from"),
      [
        "database",
        P.seqObj<string, any>(["name", r.databaseName], ["alias", r.asAlias]),
      ],
      ["join", r.join.or(optional)],
      ["where", r.where.or(optional)],
      ["limit", r.limit.or(optional)]
    )
      .skip(r.comment)
      .thru((parser) => whitespace.then(parser))
  },

  parameters: (r) => {
    return r.lParenthesis
      .then(r.pairCondition.sepBy(r.comma))
      .skip(r.rParenthesis)
  },

  fetch: (r) => {
    return P.seqObj<any, any>(
      ["command", word("fetch")],
      ["type", r.text],
      ["parameters", r.parameters]
    )
      .skip(r.comment)
      .thru((parser) => whitespace.then(parser))
  },

  create: (r) => {
    return P.seqObj<any, any>(
      ["command", word("create")],
      ["type", r.text],
      ["name", r.text],
      ["parameters", r.parameters.or(optional)]
    )
      .skip(r.comment)
      .thru((parser) => whitespace.then(parser))
  },

  getConfig: (r) => {
    return P.seqObj<any, any>(
      ["command", word("get")],
      ["type", word("config")],
      ["parameters", r.parameters]
    )
      .skip(r.comment)
      .thru((parser) => whitespace.then(parser))
  },

  updateConfig: (r) => {
    return P.seqObj<any, any>(
      ["command", word("update")],
      ["type", word("config")]
    )
      .skip(r.comment)
      .thru((parser) => whitespace.then(parser))
  },

  parser: (r) => {
    return P.alt(r.fetch, r.select, r.create, r.getConfig, r.updateConfig)
  },
})

///////////////////////////////////////////////////////////////////////

let text = `\
where 
  t.user_id = 10 and 
  obj = { "name": "Linh" } and
  scan in point(current_points, 1000)
`

let text2 = `\
-- hello
create config test
-- hello
`

let text3 = `\
-- hello
get config (
  -- hello
  id = 43234,
  type = 'metabase'
)
-- hello
`

let text4 = `\
-- hello
update config
-- hello
`

let text5 = `\
-- hello
create widget test (
  id = 1234,
  type = 'vertical-bar',
  column = 'name'
)
-- hello
`

let text6 = `\
-- hello
fetch title38 (
  query = 'nearby order_stop',
  filter = {
    "order_status": ["=", 1]
  }
)
-- hello
`

type Option<T> = T | null

interface Join {}

interface SelectAst {
  command: "select"
  database: {
    alias: Option<string>
    name: Option<string>
  }
  join: null
  limit: null
  where: null
}

type AreaNames = string[]

const baseApi = axios.create({
  baseURL: "https://tile38.ahamove.com/query",
})

baseApi.interceptors.response.use((response) => {
  return response.data.data
})

export const memorizeAreas = {
  admin2: {},
  admin3: {},
  admin4: {},
  get(level: string, name: string) {
    return this[level][name]
  },
}

const str2Number = (str: string) => {
  return str
    .split("")
    .map((c) => c.charCodeAt(0))
    .join("")
}

export const getAdminLevelQuery = (
  level: string,
  name: string,
  name3?: string,
  name4?: string
) => {
  switch (level) {
    case "admin2":
      return `scan admin-2 where name_${name} 1 1`
    case "admin3":
      return `scan admin-3 where name_${name} 1 1 where parent_id_level_2 ${name3} ${name3}`
    case "admin4":
      return `scan admin-4 where name_${name} 1 1 where parent_id_level_2 ${name3} ${name3} where parent_id_level_3 ${name4} ${name4}`
  }
}

export const getAdminLevel = async (areas: AreaNames) => {
  const admin = {
    name: "",
    level: "",
    ids: [],
    geometry: "",

    getAdminId(level: number) {
      return this.ids[level - 2]
    },
  }

  // level 2
  if (areas[0]) {
    let admin2 = memorizeAreas.get("admin2", areas[0])

    if (!admin2) {
      admin2 = await baseApi
        .post("", {
          query: getAdminLevelQuery("admin2", areas[0]),
        })
        .then((data) => data[1]?.[0])
    }

    if (admin2) {
      admin.name = areas[0]
      admin.level = "admin-2"
      admin.ids[0] = admin2[0]
      admin.geometry = admin2[1]

      memorizeAreas.admin2[admin.name] = {
        name: areas[0],
        id: admin2[0],
        geometry: admin2[1],
      }
    }
  }

  if (areas[1]) {
    let admin3 = memorizeAreas.get("admin3", areas[1])

    if (!admin3) {
      await baseApi
        .post("", {
          query: getAdminLevelQuery("admin2", areas[0], admin.getAdminId(2)),
        })
        .then((data) => data[1]?.[0])
    }

    if (admin3) {
      admin.name = areas[1]
      admin.level = "admin-3"
      admin.ids[1] = admin3[0]
      admin.geometry = admin3[1]

      memorizeAreas.admin3[admin.name] = {
        name: areas[1],
        id: admin3[0],
        geometry: admin3[1],
      }
    }
  }

  if (areas[2]) {
    let admin4 = memorizeAreas.get("admin3", areas[2])

    if (!admin4) {
      await baseApi
        .post("", {
          query: getAdminLevelQuery(
            "admin2",
            areas[0],
            admin.getAdminId(2),
            admin.getAdminId(3)
          ),
        })
        .then((data) => data[1]?.[0])
    }

    if (admin4) {
      admin.name = areas[2]
      admin.level = "admin-4"
      admin.ids[2] = admin4[0]
      admin.geometry = admin4[1]

      memorizeAreas.admin4[admin.name] = {
        name: areas[1],
        id: admin4[0],
        geometry: admin4[1],
      }
    }
  }

  return admin
}

export const normalizeAreaName = (name: string) => {
  return name
    .split("_")
    .map((str) => str.charAt(0).toUpperCase() + str.slice(1).toLowerCase())
    .join("_")
}

export const getAreas = (ast) => {
  if (!ast.where) {
    return null
  }

  const token = ast.where.find((o) => o.right?.fnName === "get")

  if (token) {
    return token.right.arguments.map(normalizeAreaName)
  }

  return null
}

export const orderStatusToNumber = (status: string) => {
  switch (status.toLowerCase().trim()) {
    case "idle":
      return 1
    case "assigning":
      return 2
    case "accepted":
      return 3
    case "in_process":
      return 4
    case "completed":
      return 5
    case "failed":
      return 6
  }
}

export const numberToOrderStatus = (status: number) => {
  switch (status) {
    case 1:
      return "idle"
    case 2:
      return "assigning"
    case 3:
      return "accepted"
    case 4:
      return "in_process"
    case 5:
      return "completed"
    case 6:
      return "failed"
  }
}

export const statusToNumber = (status: string) => {
  switch (status.toLowerCase().trim()) {
    case "online":
      return 1
    case "busy":
      return 2
    case "offline":
      return 3
  }
}

export const numberToStatus = (status: number) => {
  switch (status) {
    case 1:
      return "online"
    case 2:
      return "busy"
    case 3:
      return "offline"
  }
}

export const parseSelect = async (ast) => {
  if (!ast.where) {
    return
  }

  const services: any[] = await axios
    .get("https://tile38.ahamove.com/services")
    .then((res) => JSON.parse(res.data.data[0]).properties)

  const { name: dbName, alias: dbAlias } = ast.database

  const tile38FnKeys = ["within", "nearby", "scan", "intersects", "search"]
  const tile38Query = {
    head: [],
    conditions: [],
    location: [],
    filter: {},
  }
  const metabaseQuery = {}

  for (const condition of ast.where) {
    const key = condition.left.key
    const alias = condition.left.alias ?? dbName
    const value = condition.right

    if (alias === "t" || alias === "tile38" || tile38FnKeys.includes(key)) {
      if (tile38FnKeys.includes(key)) {
        tile38Query.head[0] = key

        if (typeof value === "object" && "fnName" in value) {
          tile38Query.location[0] = value.fnName

          switch (value.fnName) {
            case "get": {
              const admin = await getAdminLevel(value.arguments)
              tile38Query.location.push(
                admin.getAdminId(value.arguments.length + 1)
              )
              break
            }
            case "point":
            case "bounds": {
              tile38Query.location.push(...value.arguments)
              break
            }
          }
        }

        continue
      }

      if (key === "id") {
        tile38Query.head[1] = value
        continue
      }

      if (key === "status") {
        const status = value.map(statusToNumber)

        tile38Query.conditions.push(
          `wherein status ${status.length} ${status.join(" ")}`
        )
        continue
      }

      if (key === "filter") {
        tile38Query.filter = value
      }

      if (key === "service") {
        const serviceIds = value
          .map((v) => services[v.toUpperCase().trim()])
          .join(" ")
        tile38Query.conditions.push(
          `wherein service ${value.length} ${serviceIds}`
        )
        continue
      }

      if (Array.isArray(value) && key === "order_status") {
        const orderStatus = value.map(orderStatusToNumber)

        tile38Query.conditions.push(
          `wherein order_status ${orderStatus.length} ${orderStatus.join(" ")}`
        )
        continue
      }

      if (Array.isArray(value)) {
        tile38Query.conditions.push(
          `wherein ${key} ${value.length} ${value.join(" ")}`
        )
        continue
      }

      if (typeof value === "number") {
        switch (condition.operator) {
          case "=":
            tile38Query.conditions.push(`where ${key} ${value} ${value}`)
            break
          case ">":
            tile38Query.conditions.push(`where ${key} ${value} +inf`)
            break
          case ">=":
            tile38Query.conditions.push(`where ${key} ${value - 1} +inf`)
            break
          case "<":
            tile38Query.conditions.push(`where ${key} -inf ${value}`)
            break
          case "<=":
            tile38Query.conditions.push(`where ${key} -inf ${value - 1}`)
            break
        }
      }
    }

    if (["m", "metabase", "u", "url"].includes(alias)) {
      if (key === "id") {
        metabaseQuery["cardid"] = value
        continue
      }

      metabaseQuery[key] = value
    }
  }

  if (ast.join) {
    const mData: any[] = await axios
      .get(`https://ep.ahamove.com/bi/v1/metabase_card`, {
        params: metabaseQuery,
      })
      .then((res) => res.data)

    const tItem: any = Object.values(ast.join).find(
      (o: any) => o.alias === "t" || o.alias === "tile38"
    )
    const mItem: any = Object.values(ast.join).find(
      (o: any) => o.alias === "m" || o.alias === "metabase"
    )
    const ids = mData.map((o) => str2Number(o[mItem.key]))

    tile38Query.conditions.push(
      `wherein ${tItem.key} ${ids.length} ${ids.join(" ")}`
    )
  }

  if ("cast_to" in metabaseQuery) {
    delete metabaseQuery["cast_to"]

    const idField = metabaseQuery["id_field"]
    const geometry = metabaseQuery["geometry"]

    delete metabaseQuery["id_field"]
    delete metabaseQuery["geometry"]

    if (!idField) {
      throw new Error("missing id_field field")
    }

    if (!geometry) {
      throw new Error("missing geometry field")
    }

    const data = await axios
      .post("https://tile38.ahamove.com/add", {
        url: `https://ep.ahamove.com/bi/v1/metabase_card?`.concat(
          qs.stringify(metabaseQuery)
        ),
        id_field: idField,
        geometry: geometry,
      })
      .then((res) => res.data.data)

    tile38Query.head[1] = data.key
  }

  console.log("tile38Query", tile38Query, metabaseQuery)

  if (dbName === "t" || dbName === "tile38") {
    const tile38Data = await axios
      .post(`https://tile38.ahamove.com/query`, {
        query: tile38Query.head
          .concat(tile38Query.conditions)
          .concat(["limit", ast.limit ?? 100])
          .concat(tile38Query.location)
          .join(" "),
        filter: tile38Query.filter,
      })
      .then((res) => res.data)

    console.log(tile38Data)
  }

  if (dbName === "m" || dbName === "metabase") {
    const metabaseData = await axios
      .get(`https://ep.ahamove.com/bi/v1/metabase_card`, {
        params: metabaseQuery,
      })
      .then((res) => res.data)

    console.log(metabaseData)
  }
}

let text1 = `\
select * from m
-- join t on t.id = m.order_id
where t.id='order-stop'
and m.id = 21041
and m.limit = 1
and t.limit = 2
and t.status = ['online', 'busy']
and t.order_status in ['ASSIGNING', 'IN_PROCESS']
and t.order_stop=1
and m.service = 'SGN-BIKE'
and t.service in ['SGN-BIKE','SGN-POOL']
and t.within in point(current_points,1000)
and m.cast_to = 't'
and m.id_field = 'order_id'
and m.geometry = {
  "type": "Point",
  "fields": ["lng", "lat"]
}
and t.filter = {
  "order_id": [
     "20MAMP72"
  ]
}
limit 10
`

const text7 = `
select * from m
where id = 21041 and
limit = 1
`

function prettyPrint(x) {
  let s = util.inspect(x, { colors: true, depth: null })
  console.log(s)
}

let ast = kql.parser.tryParse(text7)
prettyPrint(ast)

parseSelect(ast).then(() => {})

export const parse = (ast) => {}

export default kql
