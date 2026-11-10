import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

/**
 * The band above the prompt is one tree that every mod's hook wraps in turn.
 * Each mod that draws a row puts a rule (key `band-rule`) above it and drops
 * the rule of the mods beneath, so one rule shows, as wide as the band.
 */
const RULE_KEY = 'band-rule'

function dropRule(node: RenderElement): RenderElement {
  const children = (node as { children?: unknown }).children
  if (!Array.isArray(children)) {
    return node
  }
  const kept = children
    .filter(child => !(isElement(child) && (child as { props?: { key?: unknown } }).props?.key === RULE_KEY))
    .map(child => (isElement(child) ? dropRule(child) : child))

  return { ...node, children: kept } as RenderElement
}

function isElement(value: unknown): value is RenderElement {
  return typeof value === 'object' && value !== null && 'type' in value
}

export async function renderBand(
  $: EngineInterface,
  e: RenderInput<'AbovePrompt'>,
  onOpen: () => void,
  next: (e: RenderInput<'AbovePrompt'>) => Promise<RenderElement>,
): Promise<RenderElement> {
  if (e.props.hasSurvey) {
    return next(e)
  }
  const { Box, Button, Text } = $.ui.resolve(e)
  const rest = dropRule(await next(e))

  return (
    <Box key="source-control-band" flexDirection="column">
      <Box key={RULE_KEY} height={1} overflow="hidden">
        <Text color="promptBorder">{'─'.repeat(Math.max(1, e.props.bodyColumns))}</Text>
      </Box>
      <Box key="source-control-band-row" flexDirection="row" alignItems="flex-end" gap={2}>
        <Box key="source-control-band-rest" flexGrow={1} flexShrink={1} flexDirection="column">
          {rest}
        </Box>
        <Box key="source-control-band-button" flexShrink={0}>
          <Button key="open-source-control" label="Source Control" plain onPress={onOpen}>
            ⎇ Git
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
