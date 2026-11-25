      // ------------------------------------------------------------ 取数

      function readJson(res) {
        return res.text().then(function (text) {
          var data = null;
          try {
            data = text === '' ? null : JSON.parse(text);
          } catch (e) {
            data = null;
          }
          if (!res.ok) {
            var msg = data && data.error ? data.error : 'HTTP ' + res.status;
            var err = new Error(msg);
            err.status = res.status;
            err.body = data;
            throw err;
          }
          return data;
        });
      }

      var BRIDGE_API = '/dsh-qq-bridge';

      function apiGet(path) {
        return fetch(API + path, { cache: 'no-store' }).then(readJson);
      }

      function apiPost(path, body) {
        return fetch(API + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        }).then(readJson);
      }

      function bridgeGet(path) {
        return fetch(BRIDGE_API + path, { cache: 'no-store' }).then(readJson);
      }

      function bridgePost(path, payload) {
        return fetch(BRIDGE_API + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload || {}),
        }).then(readJson);
      }

      function apiSave(payload) {
        return fetch(API + '/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(readJson);
      }

      // ------------------------------------------------------------ 小工具

      function clockOf(iso) {
        if (typeof iso !== 'string' || iso === '') return '—';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '—';
        var now = new Date();
        var pad = function (x) {
          return x < 10 ? '0' + x : String(x);
        };
        var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
        var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
        return sameDay ? hm : pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + hm;
      }

      function secLabel(ms) {
        var s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
        if (s < 60) return s + ' 秒';
        var m = Math.floor(s / 60);
        if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
        return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
      }

      function untilLabel(iso) {
        if (typeof iso !== 'string' || iso === '') return '—';
        var t = new Date(iso).getTime();
        if (isNaN(t)) return '—';
        var diff = t - Date.now();
        if (diff <= 0) return '马上';
        return clockOf(iso) + '（' + secLabel(diff) + '后）';
      }

      var DECISION_TEXT = { send: '发了', skip: '没发' };

