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