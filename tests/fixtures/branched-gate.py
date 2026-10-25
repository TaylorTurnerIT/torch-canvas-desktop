import torch
import torch.nn as nn


class Gate(nn.Module):
    """Two projections of the same normalized input, multiplied elementwise."""

    def __init__(self, width=4):
        super().__init__()
        self.norm = nn.LayerNorm(width)
        self.left = nn.Linear(width, width)
        self.right = nn.Linear(width, width)

    def forward(self, x):
        n = self.norm(x)
        return self.left(n) * self.right(n)

    def extra_method(self):
        return 'keep this method'


class GatedNet(nn.Module):
    def __init__(self, width=4):
        super().__init__()
        self.gate = Gate(width)
        self.head_norm = nn.LayerNorm(width)

    def forward(self, x):
        return self.head_norm(self.gate(x))

    def predict(self, x):
        return self(x)


# Keep unrelated notebook code unchanged.
TRAINING_SETTING = 123
