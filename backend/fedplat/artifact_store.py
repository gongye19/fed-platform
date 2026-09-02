from __future__ import annotations

from typing import BinaryIO

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from fedplat.settings import Settings


class ArtifactStoreError(RuntimeError):
    pass


class S3ArtifactStore:
    def __init__(self, settings: Settings) -> None:
        self.bucket = settings.s3_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key_id,
            aws_secret_access_key=settings.s3_secret_access_key,
            config=Config(s3={"addressing_style": settings.s3_url_style}),
        )

    @staticmethod
    def object_key(app_id: str, federation_id: str, digest: str) -> str:
        digest_hex = digest.removeprefix("sha256:")
        return f"artifacts/{app_id}/{federation_id}/sha256/{digest_hex[:2]}/{digest_hex}"

    def health(self) -> None:
        try:
            self.client.head_bucket(Bucket=self.bucket)
        except (BotoCoreError, ClientError) as exc:
            raise ArtifactStoreError("object storage is unavailable") from exc

    def put_file(
        self,
        *,
        app_id: str,
        federation_id: str,
        digest: str,
        size_bytes: int,
        media_type: str,
        file: BinaryIO,
    ) -> str:
        key = self.object_key(app_id, federation_id, digest)
        digest_hex = digest.removeprefix("sha256:")
        try:
            existing = self.client.head_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            if status != 404:
                raise ArtifactStoreError("failed to inspect artifact object") from exc
        except BotoCoreError as exc:
            raise ArtifactStoreError("failed to inspect artifact object") from exc
        else:
            if (
                existing["ContentLength"] != size_bytes
                or existing.get("Metadata", {}).get("sha256") != digest_hex
            ):
                raise ArtifactStoreError("existing artifact object failed integrity verification")
            return key

        try:
            file.seek(0)
            self.client.upload_fileobj(
                file,
                self.bucket,
                key,
                ExtraArgs={"ContentType": media_type, "Metadata": {"sha256": digest_hex}},
            )
            stored = self.client.head_object(Bucket=self.bucket, Key=key)
            if stored["ContentLength"] != size_bytes:
                raise ArtifactStoreError("stored artifact size verification failed")
        except (BotoCoreError, ClientError) as exc:
            raise ArtifactStoreError("failed to store artifact object") from exc
        return key

    def delete(self, key: str) -> None:
        try:
            self.client.delete_object(Bucket=self.bucket, Key=key)
        except (BotoCoreError, ClientError) as exc:
            raise ArtifactStoreError("failed to delete artifact object") from exc

    def read_bytes(self, key: str, expected_size: int) -> bytes:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
            content = response["Body"].read(expected_size + 1)
        except (BotoCoreError, ClientError) as exc:
            raise ArtifactStoreError("failed to read artifact object") from exc
        if len(content) != expected_size:
            raise ArtifactStoreError("artifact object size verification failed")
        return content

    def download_url(self, key: str, expires_in: int = 900) -> str:
        try:
            return self.client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self.bucket, "Key": key},
                ExpiresIn=expires_in,
            )
        except (BotoCoreError, ClientError) as exc:
            raise ArtifactStoreError("failed to authorize artifact download") from exc
