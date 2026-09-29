# K08-时间线与地图UI

> 类别：K-软件工程与产品 ｜ 世界构建金字塔层级：工程层 · 软件工程
> 质量要求：信息来源 ≥6 条、覆盖 ≥3 种来源类型；URL 必须来自真实检索结果。

## 1. 领域定义

研究两类时间（世界编年史=虚构纪年、剧情轴=章节序）与两类空间（地图底图 + 地点标注 + 事件锚点）的 UI 实现：时间轴组件选型、历法在渲染层的映射、地图方案选型、以及时间–空间–实体的三向联动。边界划分：C02 提供纪年/历法/事件数据模型，F05 提供叙事顺序理论，B01 提供地图绘制与分层管线，K03 管存储格式；本领域负责"怎么排、怎么画、怎么联动"。docs/01 §4.2 与 §4.9 明确要求：时间线"内部统一数字刻度，虚构纪年与多历法在渲染层映射"，地图"图片底图 + 地点标注 + 事件锚点，借鉴 Azgaar 分层思路"。

## 2. 核心知识框架

1. **时间轴组件选型 vis-timeline**。data 分两类：items（`start/end` 可选/content/`group`/`type`/`editable`/`style`）与 groups（泳道）；用 DataSet 双向绑定，可拖拽增删改；DOM+CSS 渲染便于定制。官方明确警告：自定义 `order` 不适合大量 items——加载时会逐项测量宽高，须限制在"最多几百项"。Graph2d 为其同族（items 用 `x/y/group`）。
2. **两类时间的统一呈现**。世界编年史使用虚构纪年（可含多历法），剧情轴使用章节序号/阅读当下（F05）。统一方案：内部全部转为"统一数字刻度"（相对锚定事件的年/日实数），渲染时按所选历法转字符串；剧情轴另设泳道，以章节 index 作刻度。
3. **虚构历法与渲染层映射（引用 C02、docs/01 §4.2）**。历法 = 纪元列表 + 年月周长度 + 闰法 + 月相；事件时点可存区间（时点精度分级，C02）。渲染层做"数字刻度 ↔ 历法字符串"双向换算，纯函数、跨纪元可测。Campfire/SummonWorlds 证明工具侧需要自定义 era/month/week/moon/season，并能校验"年份不整除周导致元旦星期漂移"这类问题。
4. **多视图复用同一数据**。世界构建工具的共识是列表/甘特/日历多视图：编年体列表、甘特泳道（势力并排）、日历（历法沉浸）——参考 World Anvil 的 Timescale/List 双模式与 C02 三视图。
5. **地图方案：图片底图 + 标注 + 锚点**。虚构地图没有真实地理坐标，主流做法是把一张图片按"边界（bounds）"铺在地图上（Leaflet `L.imageOverlay(url, bounds)`），并可用 `L.CRS.Simple` 表示非地理坐标系；标注（marker）与弹窗（popup）承载地点实体，事件锚点把事件指到坐标。
6. **分层思路（借鉴 Azgaar、B01）**。FMG 把地图拆成独立图层（地形/政治/路线/区域/标记/军事），各自可切换、可独立重生成。世界地图同理：底图 + 政治层 + 地貌层 + 事件层 + 行程线，图层可单独显隐。
7. **时空联动**。World Anvil Chronicles 把编年史与互动地图绑定：滚动/选择事件时地图自动跳转到事件发生地，事件与地图标记双向链接——这是"时间–空间–实体"三向联动的产品范本；其时间线还支持四泳道承载并行事件。
8. **多视角伪史书在时间线上的表达（引用 C02/F05）**。同一事件挂多条世界内记载（正史/野史/敌方/民间），时间轴上同一时点可叠多版本泳道，或在事件卡内切换视角；叙事顺序（闪回/预叙）作为剧情轴上的连线，与故事时间轴对照。
9. **渲染选型权衡**。Leaflet（成熟、插件多、markercluster/Canvas 图层，但需瓦片或图片 bounds）vs 自绘 Canvas（完全可控、适合超大地图/自定投影，但要自实现缩放平移与拾取）。虚构地图通常选 Leaflet + ImageOverlay，大规模标注用聚类或 Canvas 图层。

## 3. 可转化为产品规则的关键实践

1. 统一数字刻度 → 所有事件/章节时间先归一为数字刻度，历法与章节序只在渲染层转换（对齐 docs/01 §4.2、C02）。
2. 事件时点存区间 → 允许"约三百年前"等模糊时点，存 `[earliest, latest]`，排序与缩放按区间（联动 C02 精度分级）。
3. 双轴泳道 → 时间轴用 groups 承载：世界史泳道（按势力/地区）、剧情轴泳道（章节序）、人物生平泳道（联动 E03）。
4. 历法渲染层映射 → 数字刻度 ↔ 历法字符串纯函数换算；多历法切换只影响显示，不改数据。
5. 多视图/双模式 → 列表（编年体）、甘特（势力并排）、日历（历法沉浸）复用同一事件集（C02 三视图）；默认 Timescale，可切 List。
6. 地图 = 图片底图 + bounds → 用户上传底图并框定 bounds，坐标以图片像素/归一化坐标记录（不用真实经纬度）。
7. 标注即地点卡 → marker 绑定 location 实体，点击 popup 显示摘要并可打开地点卡（联动 K07）。
8. 事件锚点 → 事件可挂坐标，编年史选中事件时地图自动定位（借鉴 World Anvil Chronicles）。
9. 分层可控 → 底图/地名/政治/事件/行程线分层，图层独立显隐；参考 Azgaar 的图层开关。
10. 时空双联动 → 时间轴↔地图↔设定卡三向：选时间定位地图与事件卡，点标记定位时间轴，均开设定卡。
11. 伪史书模式 → 同一时点堆叠多版本记载泳道/卡内切换；叙事顺序连线（闪回）与故事时间轴对照（C02/F05）。
12. 性能与规模 → 巨大时间跨度用"时间断点压缩"（World Anvil 的 large time gaps 处理），大标注量用聚类/Canvas 图层。

## 4. 信息来源

1. [官方文档] vis-timeline — Timeline — https://visjs.github.io/vis-timeline/docs/timeline/ — items(start/end/content/group/type) 与 groups 泳道、DataSet 双向绑定、DOM/CSS 渲染；自定义 order 不适合大量 items。
2. [官方文档] vis-timeline — Graph2d — https://visjs.github.io/vis-timeline/docs/graph2d/ — 同族图表，items(x,y,group)，DOM+SVG 渲染。
3. [官方文档] vis-timeline — Timeline Examples — https://visjs.github.io/vis-timeline/examples/timeline/ — 可编辑 items/groups、背景区间、并行泳道与性能示例的官方索引。
4. [官方文档] Leaflet API reference — https://leaflet.github.io/Leafdoc/Leaflet-docs.html — Map/Marker/Popup/LayerGroup/ImageOverlay 等类与工厂方法。
5. [官方文档] Leaflet — Quick Start Guide — https://leafletjs.cn/examples/quick-start/ — 瓦片图层、标记/圆/多边形、marker.bindPopup 用法。
6. [课程教程] TutorialsPoint — LeafletJS Overlays — https://www.tutorialspoint.com/leafletjs/leafletjs_overlay.htm — `L.imageOverlay(imageUrl, imageBounds)` 把单张图片铺在指定边界上。
7. [社区讨论] 博客园 — leaflet 的简单使用 — https://www.cnblogs.com/weiyanei/p/17044115.html — `L.CRS.Simple` + `L.imageOverlay` 用非地理坐标图片做地图（虚构地图无真实坐标的关键技巧）。
8. [开源项目] Azgaar's Fantasy Map Generator — https://github.com/Azgaar/Fantasy-Map-Generator — 开源分层世界地图生成器。
9. [技术文章] DeepWiki — FMG Advanced Features — https://deepwiki.com/Azgaar/Fantasy-Map-Generator/6-advanced-features — routes/zones/ice/markers/military 独立图层数组与 toggle 开关（分层思路来源）。
10. [官方文档] World Anvil — Chronicles — https://www.worldanvil.com/learn/chronicles/chronicles — 编年史与互动地图绑定：滚动/选事件→地图跳转标记；时间线四泳道并行事件、era names。
11. [官方文档] World Anvil — Timelines — https://www.worldanvil.com/learn/timelines/timelines — Timescale/List 双模式、era、并行事件、迷你地图与大时间间隔处理。
12. [官方文档] Campfire — Calendar Module — https://www.campfirewriting.com/calendar-creator — 自定义 era/month/week/moon/season，并可与时间线双向联动。
13. [技术文章] Summon Worlds — Fantasy Calendar Maker — https://www.summonworlds.com/resources/fantasy-calendar-maker/ — 日历结构化字段与校验（年份不整除周导致元旦星期漂移）、Markdown/JSON 导出。

## 5. 对御书设计的启示

**数据结构建议：统一时间刻度 + 历法 + 地图标注**

```yaml
# 事件：先归一为数字刻度，历法/章节序仅在渲染层转换（对齐 C02、docs/01 §4.2）
timeline_event:
  id: evt-0007
  title: 玄天宗立宗
  world_time: { scale: 1230, precision: year }   # 统一数字刻度（相对锚定事件 Year 0）
  range: [1228, 1232]                            # 模糊时点区间（C02 精度分级）
  calendar_ref: cal-xuantian                     # 显示用历法
  display: "玄元历 1230 年"                        # 按 calendar 换算出的字符串
  place_ref: loc-xuanshan                        # 事件锚点 → 地图坐标（可空）
  participants: [fac-xuantian, char-0001]        # 联动 K07 nodes
  accounts:                                      # 多视角伪史书（C02）
    - {sayer: 宗门正史, stance: fac-xuantian, bias: 美化}
    - {sayer: 敌对宗门残卷, stance: fac-mo, bias: 隐瞒}
```

```yaml
# 虚构历法（渲染层纯函数换算）
calendar:
  id: cal-xuantian
  epoch: { anchor_event: evt-0001, year_zero: 0 }
  eras: [{ name: 玄元, start: 0 }, { name: 太初, start: 1500 }]
  units: { days_per_year: 360, week: 6, leap: "每 5 年闰 1 日",
           months: [{ name: 正月, days: 30 }, { name: 二月, days: 30 }] }
```

```yaml
# 地图：图片底图 + bounds + 分层 + 标注 + 事件锚点（借鉴 Azgaar 分层）
map:
  id: map-world
  base_image: assets/map/world.png
  crs: simple                      # L.CRS.Simple，归一化坐标非经纬度
  bounds: [[0, 0], [1000, 1400]]   # 图片像素边界
  layers:
    - {id: terrain,  type: image,    visible: true}
    - {id: political, type: region,  visible: false}
    - {id: markers,  type: marker,   visible: true}
    - {id: routes,   type: polyline, visible: false}
  markers:
    - {id: loc-xuanshan, xy: [420, 610], icon: mountain, entity_ref: loc-xuanshan}
  event_anchors:
    - {event_ref: evt-0007, xy: [420, 610]}   # 时间↔空间联动
```

**校验规则建议**

- `tl-scale-missing`：事件只有展示字符串而无数字刻度 → error（无法排序/缩放）。
- `tl-range-invalid`：`range` 上界 < 下界，或与 `precision` 矛盾 → error。
- `tl-calendar-convert`：`display` 字符串与按 `calendar` 换算结果不一致 → warn（渲染层与数据脱同步）。
- `tl-chapter-axis-gap`：剧情轴中相邻章节序缺失/重复 → error（联动 I01 序号校验）。
- `tl-paradox`：起因事件刻度晚于后果事件 → warn（联动 C02 时间倒置检测，模糊时点用区间求交）。
- `map-bounds-missing`：地图无 `bounds` 或 `bounds` 与图片尺寸不匹配 → error。
- `map-marker-orphan`：marker 的 `entity_ref` 找不到地点实体 → error（联动 B01/K03）。
- `map-marker-overlap`：同层多点重合超阈值 → info，建议聚类。

**功能建议**

- 时间轴多视图：编年体列表（默认）、甘特泳道（势力/地区并排）、日历视图（历法沉浸），复用同一事件集。
- 世界史 / 剧情 / 人物生平三组泳道，剧情轴以章节序作刻度、可叠加闪回连线（F05）。
- 伪史书视图：选中年份堆叠多版本记载泳道，事件卡内切换视角（C02）。
- 地图编辑器：上传底图 → 框定 bounds → 放 marker/区域/行程线 → 绑定实体；图层开关；选事件自动定位（World Anvil Chronicles）。
- 时空联动：点 marker 跳到时间轴对应事件，选事件定位地图锚点，两者都能打开设定卡抽屉（联动 K07）。

**AI 提示词建议**

- 「历法换算核对」：给出数字刻度与历法定义，校验 `display` 字符串与换算结果。
- 「事件时空补全」：读取事件文本，抽取/建议 `place_ref` 与 `participants`，供人工确认。

## 6. 领域内子主题备忘（可选）

- 时间断点压缩（巨大时间跨度下的可视缩放）。
- 多历法并存与"同一时点不同文明叫法"的对照视图。
- 地图投影与"世界是球"时的形变表达（联动 B01）；地下/水下地图。
- 行程线/迁徙动画作为叙事道具与地图上的动态演示。