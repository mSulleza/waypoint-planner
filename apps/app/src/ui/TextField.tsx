import { MASK } from '@waypoint/core'
import { useId, useState, type ReactNode, type Ref } from 'react'
import { Platform, TextInput, View, type TextInputProps, type TextStyle } from 'react-native'
import { Icon } from './icons'
import { maskFigures } from './mask-text'
import { Text } from './Text'
import { fontFor, MIN_TARGET, TYPE, useFocusRing, useMask, useTheme } from './theme'
import { FOCUS_RING_WIDTH, iconNudge, LINE_WIDTH, RADII, SPACE, STATUS_ICON } from './tokens'

type Passed = 'inputMode' | 'autoComplete' | 'textContentType' | 'secureTextEntry' | 'maxLength' | 'onSubmitEditing' | 'returnKeyType' | 'enterKeyHint' | 'autoFocus' | 'autoCapitalize' | 'autoCorrect' | 'editable' | 'placeholder' | 'multiline' | 'numberOfLines'

export interface TextFieldProps extends Pick<TextInputProps, Passed> {
  // Shown above the field and read as its name.
  label: string
  value: string
  onChangeText: (text: string) => void
  // What to type, under the label.
  hint?: string
  // What the value reads as (a currency's name, a date), under the field while there is no error.
  note?: string | null
  // What is wrong with the value, under the field with an icon.
  error?: string | null
  // Tabular figures at body size, for days, rates and currency codes.
  numbers?: boolean
  // A one-time code: headline weight and wide tracking, so each digit stands apart. Sign-in only.
  code?: boolean
  // Shown in capitals without rewriting what is typed: a rewrite on each keystroke breaks a phone keyboard's word in progress.
  upper?: boolean
  // An amount: decimal keypad, the currency code inside the field, and masked by the eye until the field is focused.
  money?: { currency: string }
  // A unit after the value, such as %.
  suffix?: string
  // The sheet's main figure: display size, its currency code in text-2 beside it.
  large?: boolean
  ref?: Ref<TextInput>
}

const MONEY_MARK = (Platform.OS === 'web' ? { dataSet: { money: '' } } : {}) as TextInputProps
// react-native-web reads blurOnSubmit, phones submitBehavior.
const KEEP_FOCUS: TextInputProps = { submitBehavior: 'submit', blurOnSubmit: false }

export function TextField({ label, value, onChangeText, hint, note, error, numbers = false, code = false, upper = false, money, suffix, large = false, ref, ...input }: TextFieldProps) {
  const { colors } = useTheme()
  const { masked } = useMask()
  const { ring, onFocus, onBlur } = useFocusRing()
  const [focused, setFocused] = useState(false)
  // The adornments sit over the field, so a tap on them still lands in it; their widths set the field's padding.
  const [prefixWidth, setPrefixWidth] = useState(0)
  const [suffixWidth, setSuffixWidth] = useState(0)
  const ids = useId()
  const figures = numbers || code || money !== undefined
  const t = large ? TYPE.display : code ? TYPE.headline : TYPE.body
  // One ring in one colour: an error's own colour while the field is wrong.
  const focusedRing: TextStyle | null = ring ? { outlineStyle: 'solid', outlineWidth: FOCUS_RING_WIDTH, outlineColor: error ? colors.negative : colors.focusRing, outlineOffset: FOCUS_RING_WIDTH } : null
  const hidden = money !== undefined && masked && !focused && value !== ''
  // The hint, then the error or the note, read after the field's name; a money field's name says its currency, which the eye never hides.
  const describedBy = [hint ? `${ids}-hint` : null, error ? `${ids}-error` : note ? `${ids}-note` : null].filter(Boolean).join(' ') || undefined
  const name = money ? `${label}, ${money.currency}${hidden ? ', amount hidden' : ''}` : label
  // Typed words, such as a bank's note, can hold an amount; it is masked too until the field is focused.
  const shown = hidden ? MASK : masked && !focused && money === undefined && !input.secureTextEntry ? maskFigures(value) : value
  const adornment = { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center', pointerEvents: 'none' } as const
  return (
    <View style={{ gap: SPACE[1] }}>
      <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
        {label}
      </Text>
      {hint ? (
        <Text nativeID={`${ids}-hint`} variant="footnote" tone="text2">
          {hint}
        </Text>
      ) : null}
      <View>
        <TextInput
          inputMode={money ? 'decimal' : undefined}
          // A prefilled amount such as a 0 is replaced by what is typed, not added to.
          selectTextOnFocus={money !== undefined}
          // Return that moves on or submits keeps the field focused, so a field that fails its own check keeps the focus it moved back to.
          {...(input.onSubmitEditing ? KEEP_FOCUS : null)}
          {...input}
          {...(money ? MONEY_MARK : null)}
          ref={ref}
          aria-label={name}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          value={shown}
          onChangeText={onChangeText}
          onFocus={(e) => {
            setFocused(true)
            onFocus(e)
          }}
          onBlur={() => {
            setFocused(false)
            onBlur()
          }}
          placeholderTextColor={colors.text3}
          style={[
            {
              minHeight: large ? MIN_TARGET + SPACE[4] : MIN_TARGET,
              paddingVertical: input.multiline ? SPACE[2] : undefined,
              textAlignVertical: input.multiline ? 'top' : undefined,
              paddingLeft: SPACE[3] + (money ? prefixWidth + SPACE[2] : 0),
              paddingRight: SPACE[3] + (suffix ? suffixWidth + SPACE[1] : 0),
              borderWidth: LINE_WIDTH,
              borderColor: error ? colors.negative : colors.controlBorder,
              borderRadius: RADII.control,
              backgroundColor: colors.surface,
              color: colors.text,
              ...fontFor(t.fontWeight),
              fontSize: t.fontSize,
              fontVariant: figures ? ['tabular-nums'] : undefined,
              letterSpacing: code ? 2 : undefined,
              textTransform: upper ? 'uppercase' : undefined,
              outlineWidth: 0,
            },
            focusedRing,
          ]}
        />
        {money ? (
          <View aria-hidden style={[adornment, { left: SPACE[3] }]} onLayout={(e) => setPrefixWidth(Math.ceil(e.nativeEvent.layout.width))}>
            <Text variant={large ? 'title2' : 'subhead'} tone="text2" style={{ fontWeight: '600' }}>
              {money.currency}
            </Text>
          </View>
        ) : null}
        {suffix ? (
          <View aria-hidden style={[adornment, { right: SPACE[3] }]} onLayout={(e) => setSuffixWidth(Math.ceil(e.nativeEvent.layout.width))}>
            <Text variant="body" tone="text2">
              {suffix}
            </Text>
          </View>
        ) : null}
      </View>
      {error ? (
        <FieldError id={`${ids}-error`} text={error} />
      ) : note ? (
        <Text nativeID={`${ids}-note`} variant="footnote" tone="text2">
          {note}
        </Text>
      ) : null}
    </View>
  )
}

// What is wrong with an answer, with an icon so the colour is never the only sign; also under choices that are not a text field. children replace text when the words hold an amount.
export function FieldError({ text, children, id }: { text?: string; children?: ReactNode; id?: string }) {
  const { colors } = useTheme()
  return (
    <View nativeID={id} role="alert" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[1] }}>
      <View style={{ paddingTop: iconNudge(TYPE.footnote.lineHeight, 16) }}>
        <Icon name={STATUS_ICON.negative} size={16} color={colors.negative} />
      </View>
      <Text variant="footnote" style={{ flex: 1, color: colors.negative, fontWeight: '600' }}>
        {children ?? text}
      </Text>
    </View>
  )
}
