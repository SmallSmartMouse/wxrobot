package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type serverConfig struct {
	Listen        string `json:"listen"`
	AllowRemote   bool   `json:"allow_remote"`
	DiscoveryPort int    `json:"discovery_port"`    // UDP 手机发现端口，0 表示关闭
	LinkListen    string `json:"phone_link_listen"` // 仅接收手机的 WSS 端口；管理网页仍仅本机可见
}

// loadServerConfig 读取服务配置。配置文件可省略；手机连接和 AI 设置由网页管理并保存在数据库中。
func loadServerConfig(path string) (serverConfig, error) {
	c := serverConfig{Listen: "127.0.0.1:8787", DiscoveryPort: defaultDiscoveryPort, LinkListen: "0.0.0.0:8788"}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return c, fmt.Errorf("读取服务配置失败：%w", err)
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("解析服务配置失败：%w", err)
	}
	if c.Listen == "" {
		return c, fmt.Errorf("服务配置 listen 不能为空")
	}
	if c.LinkListen == "" {
		return c, fmt.Errorf("服务配置 phone_link_listen 不能为空：手机经这个端口连接电脑")
	}
	if c.DiscoveryPort < 0 || c.DiscoveryPort > 65535 {
		return c, fmt.Errorf("discovery_port 必须为 0 到 65535")
	}
	return c, nil
}
