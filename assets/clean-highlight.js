// assets/js/clean-highlight.js
document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('div.highlight').forEach(function(div) {
      // 获取所有子节点
      var children = div.childNodes;
      // 从后往前遍历（安全删除）
      for (var i = children.length - 1; i >= 0; i--) {
        var node = children[i];
        // 如果是文本节点且只包含空白字符
        if (node.nodeType === 3 && /^\s*$/.test(node.textContent)) {
          div.removeChild(node);
        }
      }
    });
  });