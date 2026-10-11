package main

// 向手机发请求：经手机主动建立的加密连接（phone_link.go）转发，路径和手机桥的接口一一对应。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"
)

// phoneCallTimeout 一次请求等手机响应的上限：事件长轮询最多等 20 秒，留出余量。
const phoneCallTimeout = 35 * time.Second

const (
	maxOriginalBytes = 40 << 20  // 一张原图文件的上限：手机拍的大图也在这之内
	maxChunkBytes    = 256 << 10 // 原图分块的上限：与手机桥的 FILE_CHUNK_BYTES 一致，避免一条消息过大
)

// phoneConn 是到一台手机的请求通道。正式运行时是手机主动建立的 WSS 连接，测试时用内存实现代替。
type phoneConn interface {
	// call 发送一个请求并等待手机的响应；连接中断或 ctx 取消时返回错误。
	call(ctx context.Context, req linkRequest) (linkMessage, error)
	// close 断开连接。
	close()
}

// linkRequest 是发给手机的一个请求。Key 是 Idempotency-Key：同一个任务重复提交，手机只执行一次。
type linkRequest struct {
	Method string
	Path   string
	Body   any
	Key    string
}

// phoneError 表示手机收到了请求，但明确拒绝（没有执行）。
type phoneError struct {
	Status  int
	Message string
}

// Error 返回手机给出的错误说明。
func (e *phoneError) Error() string { return e.Message }

// rejectedByPhone 表示请求已送达手机，但被手机明确拒绝（没有执行）。
func rejectedByPhone(err error) bool {
	var rejected *phoneError
	return errors.As(err, &rejected)
}

// phoneRequest 调用手机桥接口，成功时把响应解析到 out（可为 nil）。
// 连接不通返回普通错误；手机拒绝时返回 *phoneError。
func (a *App) phoneRequest(ctx context.Context, phoneID, method, path string, body any, key string, out any) error {
	response, err := a.callPhone(ctx, phoneID, linkRequest{Method: method, Path: path, Body: body, Key: key})
	if err != nil {
		return err
	}
	if out != nil && json.Unmarshal(response.Body, out) != nil {
		return errors.New("手机返回的数据格式无效")
	}
	return nil
}

// callPhone 经手机的连接发送请求并等待响应；手机返回错误状态时转成 *phoneError。
func (a *App) callPhone(ctx context.Context, phoneID string, req linkRequest) (linkMessage, error) {
	conn := a.phoneConnOf(phoneID)
	if conn == nil {
		return linkMessage{}, errors.New("等待手机主动连接")
	}
	ctx, cancel := context.WithTimeout(ctx, phoneCallTimeout)
	defer cancel()
	response, err := conn.call(ctx, req)
	if err != nil {
		return response, err
	}
	if response.Status < 200 || response.Status >= 300 {
		return response, rejection(response)
	}
	return response, nil
}

// phoneConnOf 手机当前的连接，没连上时返回 nil。
func (a *App) phoneConnOf(phoneID string) phoneConn {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.links[phoneID]
}

// rejection 取出手机给的错误说明，没有就用笼统说明。
func rejection(response linkMessage) *phoneError {
	var fault struct {
		Error struct{ Message string } `json:"error"`
	}
	_ = json.Unmarshal(response.Body, &fault)
	if fault.Error.Message == "" {
		fault.Error.Message = fmt.Sprintf("手机请求失败（%d）", response.Status)
	}
	return &phoneError{response.Status, fault.Error.Message}
}

// phoneDownload 分块下载手机上的文件（原图），全部取完后通知手机删除。
func (a *App) phoneDownload(ctx context.Context, phoneID, path string) ([]byte, error) {
	var data []byte
	for {
		chunk, size, err := a.downloadChunk(ctx, phoneID, path, len(data))
		if err != nil {
			return nil, err
		}
		data = append(data, chunk...)
		if len(data) == size {
			_, _ = a.callPhone(ctx, phoneID, linkRequest{Method: "GET", Path: path + "?done=1"})
			return data, nil
		}
		if len(chunk) == 0 {
			return nil, errors.New("原图传输中断")
		}
	}
}

// downloadChunk 取文件从 offset 开始的一块，并返回文件总大小。
func (a *App) downloadChunk(ctx context.Context, phoneID, path string, offset int) ([]byte, int, error) {
	m, err := a.callPhone(ctx, phoneID, linkRequest{Method: "GET", Path: fmt.Sprintf("%s?offset=%d", path, offset)})
	if err != nil {
		return nil, 0, err
	}
	var part struct {
		Data string `json:"data"`
		Size int    `json:"size"`
	}
	if json.Unmarshal(m.Body, &part) != nil || part.Size < 0 || part.Size > maxOriginalBytes {
		return nil, 0, errors.New("原图大小无效")
	}
	chunk, err := base64.StdEncoding.DecodeString(part.Data)
	if err != nil || len(chunk) > maxChunkBytes || offset+len(chunk) > part.Size {
		return nil, 0, errors.New("原图分块无效")
	}
	return chunk, part.Size, nil
}

// downloadOriginals 下载读取结果中手机保存的原图文件（手机发送后即删除），
// 把 original_file 换成本地的 original_hash，失败则记下原因。
func (a *App) downloadOriginals(ctx context.Context, phoneID string, result json.RawMessage) json.RawMessage {
	var r map[string]any
	if json.Unmarshal(result, &r) != nil {
		return result
	}
	messages, _ := r["messages"].([]any)
	for _, item := range messages {
		m, _ := item.(map[string]any)
		name, _ := m["original_file"].(string)
		if name == "" {
			continue
		}
		delete(m, "original_file")
		hash, err := a.fetchOriginal(ctx, phoneID, name)
		if err != nil {
			m["original_error"] = "原图下载或保存失败：" + err.Error()
		} else {
			m["original_hash"] = hash
		}
	}
	b, err := json.Marshal(r)
	if err != nil {
		return result
	}
	return b
}

// fetchOriginal 下载一张原图并保存，返回图片哈希。
func (a *App) fetchOriginal(ctx context.Context, phoneID, name string) (string, error) {
	data, err := a.phoneDownload(ctx, phoneID, "/v1/files/"+url.PathEscape(name))
	if err != nil {
		return "", err
	}
	return a.saveOriginal(data)
}
