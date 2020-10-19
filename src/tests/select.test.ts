import kql from "../"

const defaultSelectAst = {
  command: 'select',
  database: {
    alias: null,
    name: null
  },
  join: null,
  limit: null,
  where: null,
}

describe('select', () => {
  it("simple select tile38", function() {
    const ast = kql.parser.tryParse(`select * from tile38`)

    expect(ast).toEqual({
      ...defaultSelectAst,
      command: 'select',
      database: {
        alias: null,
        name: 'tile38'
      },
    })
  })

  it("simple select t", function() {
    const ast = kql.parser.tryParse(`select * from t`)

    expect(ast).toEqual({
      ...defaultSelectAst,
      command: 'select',
      database: {
        alias: null,
        name: 't'
      },
    })
  })

  it("tile38 alias", function() {
    const ast = kql.parser.tryParse(`select * from tile38 as hello`)

    expect(ast).toEqual({
      ...defaultSelectAst,
      command: 'select',
      database: {
        alias: 'hello',
        name: 'tile38'
      },
    })
  })

  it("case sensitivity", function() {
    const ast = kql.parser.tryParse(`SELECT * FROm tile38 AS hello`)

    expect(ast).toEqual({
      ...defaultSelectAst,
      command: 'select',
      database: {
        alias: 'hello',
        name: 'tile38'
      },
    })
  })

  it("where clause", function() {
    const ast = kql.parser.tryParse(`
    select * from m where email = 'lynkxyz@gmail.com'
    `)

    expect(ast).toEqual({
      ...defaultSelectAst,
      command: 'select',
      database: {
        alias: null,
        name: 'm'
      },
      where: [
        {
          left: {
            alias: null,
            key: 'email'
          },
          operator: '=',
          right: 'lynkxyz@gmail.com'
        }
      ]
    })
  })

  it("where clause multiple conditions", function() {
    const ast = kql.parser.tryParse(`
    select * from m where 
      email = 'lynkxyz@gmail.com' and
      age = 18
    `)

    expect(ast).toEqual({
      ...defaultSelectAst,
      command: 'select',
      database: {
        alias: null,
        name: 'm'
      },
      where: [
        {
          left: {
            alias: null,
            key: 'email'
          },
          operator: '=',
          right: 'lynkxyz@gmail.com'
        },
        {
          left: {
            alias: null,
            key: 'age'
          },
          operator: '=',
          right: 18
        }
      ]
    })
  })
})


let testCreateConfig = `\
-- hello
create config test
-- hello
`

let testGetConfig = `\
-- hello
get config (
  -- hello
  id = 43234,
  type = 'metabase'
)
-- hello
`

let testUpdateConfig = `\
-- hello
update config
-- hello
`

let testCreateWidget = `\
-- hello
create widget test (
  id = 1234,
  type = 'vertical-bar',
  column = 'name'
)
-- hello
`

let testFetch = `\
-- hello
fetch title38 (
  query = 'nearby order_stop',
  filter = {
    "order_status": ["=", 1]
  }
)
-- hello
`


let testSelect = `\
select * from m
join t on t.id = m.order_id
where t.id='order-stop'
and m.id = 21041
and m.limit = 1
and t.limit = 2
and t.status = ['online', 'busy']
and t.order_status in ('ASSIGNING', 'IN_PROCESS')
and t.order_stop=1
and m.service = 'SGN-BIKE'
and t.service in ['SGN-BIKE','SGN-POOL']
and t.nearby in point(current_points,1000)
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
