//go:build !darwin

package keychain

import "errors"

const ServiceName = "tw.caliber.agent"

var SecurityBin = "" // unused on non-darwin; kept for API symmetry

var ErrNotFound = errors.New("keychain: not found")
var ErrUnsupported = errors.New("keychain: not supported on this platform")

func Set(account, secret, keychainPath string) error { return ErrUnsupported }
func Get(account, keychainPath string) (string, error) {
	return "", ErrUnsupported
}
func Delete(account, keychainPath string) error { return ErrUnsupported }
