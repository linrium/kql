import * as util from "util"
import * as P from "parsimmon"
import axios from "axios"
import _ from "lodash"
import * as qs from "query-string"
import * as dayjs from "dayjs"

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
  array: (r) =>
    P.alt(r.lbracket, r.lParenthesis)
      .then(r.value.sepBy(r.comma))
      .skip(P.alt(r.rbracket, r.rParenthesis)),

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
      word("in"),
      word("is"),
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
      [
        "database",
        P.seqObj<string, any>(["name", r.databaseName], ["alias", r.asAlias]),
      ],
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

export default kql
