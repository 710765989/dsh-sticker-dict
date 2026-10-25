/**
 * dsh-sticker-dict —— 插件页客户端面板。
 *
 * 注册到 `plugins.row.config` 槽位：插件列表里 sticker-dict 那一行的配置区
 * 就是这张卡片。有两个开关（抽帧 / 字典），读写走
 * POST /api/dsh-sticker-dict-settings/{describe,mutate}。
 */
window.__ModuleLoader__.load({
  id: "dsh-sticker-dict",
  factory: (require) => {
    const react = require("react");
    const h = react.createElement;
    const { useState, useEffect, useCallback } = react;

    const BRIDGE_PREFIX = "/api/dsh-sticker-dict-settings";

    /** 走 bridge 读当前配置。 */
    async function bridgeDescribe() {
      const res = await fetch(`${BRIDGE_PREFIX}/describe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(`describe 失败：HTTP ${res.status}`);
      return res.json();
    }

    /** 走 bridge 写配置：ops 形如 [{op:"set", path:["frames","enabled"], value:false}]。 */
    async function bridgeMutate(ops) {
      const res = await fetch(`${BRIDGE_PREFIX}/mutate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ns: "sticker-dict", ops }),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body && typeof body.error === "string") detail = body.error;
        } catch {}
        throw new Error(detail);
      }
      return res.json();
    }

    const styles = {
      wrap: {
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        padding: "14px 16px",
        borderRadius: "10px",
        background: "var(--dsh-surface-2, rgba(127,127,127,0.06))",
        fontSize: "13px",
        lineHeight: 1.5,
      },
      row: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
      },
      label: { display: "flex", flexDirection: "column", gap: "2px" },
      name: { fontWeight: 600 },
      hint: { opacity: 0.66, fontSize: "12px" },
      switch: {
        position: "relative",
        flex: "0 0 auto",
        width: "42px",
        height: "24px",
        borderRadius: "12px",
        border: "none",
        cursor: "pointer",
        transition: "background 120ms ease",
        padding: 0,
      },
      knob: {
        position: "absolute",
        top: "3px",
        width: "18px",
        height: "18px",
        borderRadius: "50%",
        background: "#fff",
        transition: "left 120ms ease",
        boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
      },
      error: { color: "var(--dsh-danger, #d33)", fontSize: "12px" },
      footer: { display: "flex", justifyContent: "space-between", opacity: 0.6, fontSize: "12px" },
    };

    function Switch(props) {
      const { checked, disabled, onChange } = props;
      return h(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": checked ? "true" : "false",
          disabled: disabled,
          onClick: () => onChange(!checked),
          style: {
            ...styles.switch,
            background: checked ? "var(--dsh-accent, #3b82f6)" : "rgba(127,127,127,0.35)",
            opacity: disabled ? 0.5 : 1,
          },
        },
        h("span", { style: { ...styles.knob, left: checked ? "21px" : "3px" } }),
      );
    }

    function Row(props) {
      const { title, hint, checked, disabled, onChange } = props;
      return h(
        "div",
        { style: styles.row },
        h("div", { style: styles.label }, h("span", { style: styles.name }, title), h("span", { style: styles.hint }, hint)),
        h(Switch, { checked, disabled, onChange }),
      );
    }

    function Card() {
      const [ready, setReady] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [cfg, setCfg] = useState({ enabled: true, frames: true, dict: true });

      const load = useCallback(async () => {
        try {
          const page = await bridgeDescribe();
          const v = page && page.value ? page.value : {};
          setCfg({
            enabled: v.enabled !== false,
            frames: !(v.frames && v.frames.enabled === false),
            dict: !(v.dict && v.dict.enabled === false),
          });
          setError("");
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setReady(true);
        }
      }, []);

      useEffect(() => {
        void load();
      }, [load]);

      const apply = useCallback(
        async (path, value) => {
          setBusy(true);
          setError("");
          try {
            await bridgeMutate([{ op: "set", path, value }]);
            await load();
          } catch (e) {
            setError(String(e && e.message ? e.message : e));
          } finally {
            setBusy(false);
          }
        },
        [load],
      );

      const off = busy || !ready || !cfg.enabled;

      return h(
        "div",
        { style: styles.wrap },
        h(Row, {
          title: "总开关",
          hint: cfg.enabled ? "插件在跑" : "整个插件停用",
          checked: cfg.enabled,
          disabled: busy || !ready,
          onChange: (next) => apply(["enabled"], next),
        }),
        h(Row, {
          title: "gif_frame_extraction · 抽帧拼图",
          hint: cfg.frames ? "GIF 抽帧后拼成一张图" : "工具已关",
          checked: cfg.frames,
          disabled: off,
          onChange: (next) => apply(["frames", "enabled"], next),
        }),
        h(Row, {
          title: "sticker_dict · 表情包字典",
          hint: cfg.dict ? "看过的表情记下来，下次不重复识图" : "工具已关",
          checked: cfg.dict,
          disabled: off,
          onChange: (next) => apply(["dict", "enabled"], next),
        }),
        error ? h("div", { style: styles.error }, error) : null,
        h("div", { style: styles.footer }, h("span", null, ready ? (busy ? "保存中…" : "配置已同步") : "读取中…")),
      );
    }

    /** 插件列表那一行折叠时显示的摘要。 */
    function summaryText() {
      return h("span", { style: { opacity: 0.7 } }, "GIF 抽帧 + 表情字典");
    }

    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register({ name: "plugins.row.config", key: "dsh-sticker-dict#sticker-dict" }, (slotProps) =>
          slotProps && slotProps.view === "summary" ? summaryText() : h(Card, null),
        ),
      );
    }

    return { inject, apply };
  },
});
