export const name = 'rabiroute-agent-invariant'
export const inject = ['invariants']
export const apply = ctx => Promise.resolve(ctx.invariants.register('@cottongame/dsh-rabiroute-agent', () => {}))
