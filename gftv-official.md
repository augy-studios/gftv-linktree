# GFTV official site banner (portable)

A slim, permanent, collapsible bar at the very top of every GFTV site, stating
that the site is official and teaching a reader how to check that for
themselves. Modelled on the Singapore Government masthead.

This is a companion to `gftv-theme.md`, deliberately kept separate. That file
is a token contract about colour, type, and shape, and anything reading it
should be able to apply it without also making a claim about authenticity. This
file is behaviour, copy, and a security statement. Copy it into any GFTV repo
that needs the banner, the same way the theme file travels.

## Be honest about what this does

**The banner cannot prove anything.** Any phishing site can copy it, pixel for
pixel, in an afternoon. The Singapore Government masthead has exactly the same
limitation and is well understood as such.

Its value is not proof, it is education. A reader who has seen the bar a few
times learns the rule: look at the end of the domain. That knowledge protects
them on the fake site, where the bar will also be present and also lying.

So the copy teaches the rule and never asserts trustworthiness. Never write
"this site is safe" or "verified". Write what the official domains are, and how
to read a domain.

**And GFTV is a weaker case than the government one.** `.gov.sg` works as a
signal because the registry is restricted: nobody outside the Singapore
government can hold one. `globalfurry.tv` and `gftv.asia` are ordinary domains
that GFTV happens to own, so a lookalike is a purchase away. That makes the
"how to read a domain" half more important here, not less, and it is why the
expanded panel explains where to look rather than only listing the endings.

## The domains

Official GFTV sites end with one of:

- `globalfurry.tv`
- `gftv.asia`

Subdomains of those are official: `careers.globalfurry.tv`,
`docs.careers.globalfurry.tv`, `policy.globalfurry.tv`, `gftv.asia`.

**What the expanded panel has to teach**, because this is the part that
actually protects anyone: read the domain from the **end**, at the last dot
before the first single slash. `globalfurry.tv.example.com` is not GFTV.
`globalfurry-tv.com` is not GFTV. `gftv.asia.login.example.net` is not GFTV.

Keep the list in one place per site and render the bar from it, so adding a
domain is one edit rather than a search through copy.

## Behaviour

- **Permanent. Not dismissible.** No close control, no "do not show again",
  nothing stored that hides it. This is the one piece of site chrome that does
  not go away, and that is the point: a bar that can be dismissed is a bar most
  readers never see again, which defeats the education it exists for.
- **Collapsed by default**, showing one line and a control to expand.
- **Expanding is remembered locally**, per site, so a reader who opens it is not
  made to open it again. Remembering the expansion is not the same as
  remembering a dismissal: the bar itself is always present either way.
- **Quiet.** One line, no colour shouting, no icon that reads as a warning. It
  sits above the header and is the least visually interesting thing on the
  page. It is a fact, not an alert.
- Expanding and collapsing animates at the same 150 to 220ms as everything
  else, and honours `prefers-reduced-motion`.

## Where it sits

At the very top of `<body>`, above the site header and above anything else.

In a repo that ships the phased build notice from section 0c of its own
specification, **this bar replaces that one** when the last phase ships. The
phase notice is temporary and dismissible; this is permanent and is not. They
occupy the same slot and must never both be present: two stacked bars above the
header is worse than either alone.

## Markup

```html
<div class="gov-bar" id="officialBar">
  <div class="gov-bar-inner">
    <img class="gov-bar-mark" src="/gftv-flag.png" alt="" width="24" height="16">
    <p class="gov-bar-line">An official Global Furry Television website</p>
    <button type="button" class="gov-bar-toggle" id="officialBarToggle"
            aria-expanded="false" aria-controls="officialBarPanel">
      How to identify
      <span data-icon="chevron-down" aria-hidden="true"></span>
    </button>
  </div>

  <div class="gov-bar-panel" id="officialBarPanel" hidden>
    <div class="gov-bar-panel-inner">
      <div class="gov-bar-point">
        <span data-icon="globe" aria-hidden="true"></span>
        <div>
          <h2>Official GFTV sites end with globalfurry.tv or gftv.asia</h2>
          <p>
            Read the address from the end, at the last dot before the first
            single slash. A site ending in anything else is not GFTV, even if
            the name appears earlier in the address.
          </p>
          <p><a href="https://gftv.asia/trusted-sites">The full list of official GFTV sites</a></p>
        </div>
      </div>
      <div class="gov-bar-point">
        <span data-icon="lock" aria-hidden="true"></span>
        <div>
          <h2>Secure sites use HTTPS</h2>
          <p>
            Look for a padlock, or https:// at the start of the address. Only
            share personal details on an official site over a secure
            connection.
          </p>
        </div>
      </div>
    </div>
  </div>
</div>
```

## Styling

Every value comes from `gftv-theme.md`. No colour is written here.

- Ground: `--bg-alt`, with a `--border` hairline underneath. Text `--text-muted`
  on the collapsed line, `--text` for the headings in the panel.
- The toggle reads as a link rather than a button: `--brand-text`, no
  underline, with the site's normal focus ring.
- The panel sits on `--bg-alt` too, so expanding reads as the same surface
  growing rather than a new one appearing.
- Icons are inline SVG coloured with `currentColor`, never emoji.
- **The mark is the GFTV flag**, `gftv-flag.png`, drawn at 24 by 16 with the
  corners barely rounded, and not an icon. Serve a small copy from the site's
  root, 72 by 48 is plenty, and never the full size flag: it is on every page.
  The image is decorative, so its `alt` is empty; the line beside it is the
  text. Settled 13 September 2026, in place of an SVG glyph.

## Responsive

- The collapsed line, the mark, and the toggle stay on one row at every width
  down to 320px. If the line will not fit, shorten the copy rather than
  wrapping to two rows: the bar must not become tall enough to push the header
  off a small screen.
- The panel is two columns above 640px and one below. Points stack in the order
  written, so the domain rule comes first on a phone, where it matters most and
  where a reader is least able to inspect an address bar.
- Respect `env(safe-area-inset-top)`, since this is the topmost element on the
  page.

## Accessibility

- `aria-expanded` on the toggle, tracking the state.
- `aria-controls` pointing at the panel, and `hidden` on the panel while
  collapsed, so it is out of the accessibility tree rather than merely
  invisible.
- The bar is not a `<dialog>`, does not trap focus, and does not close on
  Escape. It is page content, not an overlay.
- Headings inside the panel are real headings, so the panel is navigable by
  heading rather than being one undifferentiated paragraph.

## Copy

Keep it short and factual. Multilingual sites translate it like any other
interface string, through their own dictionary.

| Slot | English | 华文 |
|---|---|---|
| Collapsed line | An official Global Furry Television website | 国际兽视官方网站 |
| Toggle | How to identify | 如何辨识 |
| Domain heading | Official GFTV sites end with globalfurry.tv or gftv.asia | 国际兽视官方网站的网址以 globalfurry.tv 或 gftv.asia 结尾 |
| Domain body | Read the address from the end, at the last dot before the first single slash. A site ending in anything else is not GFTV, even if the name appears earlier in the address. | 请从网址末尾开始看，也就是第一个单斜线之前的最后一个点。结尾不是这两者的网站都不是国际兽视，即使网址前面出现了相同的名称。 |
| Trusted link | The full list of official GFTV sites | 国际兽视官方网站的完整清单 |
| Secure heading | Secure sites use HTTPS | 安全网站使用 HTTPS |
| Secure body | Look for a padlock, or https:// at the start of the address. Only share personal details on an official site over a secure connection. | 请留意地址栏的锁形图标，或网址开头的 https://。只在安全连接下的官方网站上填写个人资料。 |

The Chinese above is Singapore Mandarin and has not been checked by a fluent
speaker. Treat it as a draft until it has.

## The trusted sites page

The Singapore masthead links to a list of trusted sites. GFTV's is at:

```text
https://gftv.asia/trusted-sites
```

Given on 12 September 2026. The domain point links to it as a plain link,
after the body copy, with the "Trusted link" wording from the copy table. Keep
the address in one constant beside the domain list, so the two things a site
has to know about officialness live together.

**Do not ship the link before the page exists.** A trust banner whose "see the
full list" link 404s does more harm than no link at all. The rule stays in
force: if the page ever moves or comes down, take the link out of the bar in
the same change, and put it back when the new address answers.

The page lists every official GFTV domain and subdomain, says plainly when it
was last updated, and sits at a short address a person can type from memory
after reading it off the bar. When a domain is added to the list a site
renders the bar from, add it to the page in the same change: the bar says
"the full list", so the list has to be full.

## Acceptance checklist

- [ ] Present on every page, above the header, with no close control anywhere
- [ ] Collapsed on a first visit, expandable, expansion remembered per site
- [ ] Never present at the same time as a phased build notice
- [ ] One row at 320px, panel stacks to one column below 640px
- [ ] `aria-expanded` tracks state, panel is `hidden` when collapsed
- [ ] Keyboard operable, visible focus ring, no focus trap
- [ ] Animates 150 to 220ms, honours `prefers-reduced-motion`
- [ ] Every colour from a theme token, no hardcoded values
- [ ] Copy claims no trustworthiness, only states the domains and how to read one
- [ ] The domain point links `https://gftv.asia/trusted-sites` as a plain link, and the link comes out if that page ever stops answering
- [ ] Inline SVG icons, the flag image as the mark, no emoji, no em dashes
